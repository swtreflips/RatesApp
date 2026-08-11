import { supabase } from '../../../lib/supabase'
import { normalizeContainerType } from '../../rates/rateGrid'
import { toDateString as toLocalDateString } from '../../../lib/dates'

/*
  Provider supply-side writes/reads (STEP 0 / S0.5 — the minimal loop).

  Data model recap:
  - A `rate_submissions` row is an ACKNOWLEDGEMENT: one per (lane, forwarder, period).
    Status 'submitted' (rates attached) or 'skipped' (0 rates) — skip is deferred.
  - `rates` are append-only, self-contained rows tied to a submission + lane.
  - Isolation/identity is the COMPANY: every row is stamped with forwarder_id (the
    isolation line in RLS) plus provider_id (the analyst, for attribution).

  Deliberately minimal here: no skip, no multi-carrier explode, no latest-per-routing.
  Those are later slices (PROVIDER_VIEW_MODEL §2–§4).
*/

/**
 * View 1 — "Lanes to fill": active demand this forwarder has NOT yet acted on.
 * (PROVIDER_VIEW_MODEL §2.) A lane drops off once anyone at the forwarder submits
 * or skips it this period — the exclusion is keyed on the COMPANY, so a teammate's
 * action clears it for everyone.
 *
 * Implemented as a client-side anti-join: fetch active lanes, fetch this forwarder's
 * acknowledgements (RLS already scopes them to the caller's company), drop the overlap.
 */
export async function fetchActiveLanes() {
  const { data: lanes, error } = await supabase
    .from('rate_request_lanes')
    .select('id, pol, pod, last_cy, fd, container_type, container_count, period, posted_at, expires_at')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
  if (error) return { lanes: [], error }

  // lanes the forwarder already acted on this period (submitted OR skipped)
  const { data: acks, error: ackErr } = await supabase
    .from('rate_submissions')
    .select('lane_id, period')
  if (ackErr) return { lanes: [], error: ackErr }

  const acted = new Set((acks ?? []).map((a) => `${a.lane_id}|${a.period}`))
  const toFill = (lanes ?? []).filter((l) => !acted.has(`${l.id}|${l.period}`))
  return { lanes: toFill, error: null }
}

/**
 * View 2 — "Active rates": the rates this forwarder currently has live.
 * (PROVIDER_VIEW_MODEL §4.) RLS scopes `rates` to the caller's company. Minimal here:
 * validity-in-the-future (or unset) + newest first — no latest-per-routing dedup yet.
 */
export async function fetchActiveRates() {
  const today = new Date().toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('rates')
    .select('id, pol, pod, last_cy, fd, carrier, rate_amount, free_days, currency, valid_until, notes, created_at')
    .or(`valid_until.gte.${today},valid_until.is.null`)
    .order('created_at', { ascending: false })
  return { rates: data ?? [], error }
}

/** Resolve the signed-in analyst's identity: their user id + their forwarder company. */
async function getIdentity() {
  const { data: { session } } = await supabase.auth.getSession()
  const user = session?.user
  if (!user) return { error: new Error('Not signed in') }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('forwarder_id')
    .eq('id', user.id)
    .single()
  if (error) return { error }
  if (!profile?.forwarder_id) {
    return { error: new Error('Your profile has no forwarder assigned — set profiles.forwarder_id') }
  }
  return { providerId: user.id, forwarderId: profile.forwarder_id }
}

// Local calendar parts, never toISOString(): a picked day has no timezone, and converting it
// to an instant shifted it back a day for anyone east of UTC. See lib/dates.js.
const toDateString = toLocalDateString

function toNumber(v) {
  return v === '' || v == null ? null : Number(v)
}

/**
 * The carriers a row should fan out into. A row's `carrier` is normally an array of
 * codes (one rate is written per code). Falls back to a single non-empty string, and
 * to `[null]` when there's no carrier — so a carrier-less row still yields exactly one
 * rate, preserving prior behavior.
 */
function carriersOf(r) {
  if (Array.isArray(r.carrier) && r.carrier.length > 0) return r.carrier
  if (typeof r.carrier === 'string' && r.carrier.trim() !== '') return [r.carrier.trim()]
  return [null]
}

/**
 * Submit provider rates — both lane-linked (answering a request) and independent.
 * @param {{ laneId?: string|null, period?: number|null, pol?: string, fd?: string,
 *           pod?: string, lastCy?: string, rate?: number|string, freeDays?: number|string,
 *           carrier?: string[]|string, validUntil?: Date|string, remarks?: string }[]} rows
 *   one entry per filled grid row. Rows with a `laneId` answer a request; rows without
 *   one are independent rates (supply that exists with no matching demand).
 * @returns {{ error: Error|null, count?: number }}
 *
 * A row's `carrier` may carry multiple codes (forwarders quote the same route + price
 * under several carriers). Each row fans out into one `rate` row per carrier — see
 * carriersOf — so the count reflects rates written, not grid rows.
 *
 * Lane-linked rows ensure exactly one `submitted` acknowledgement per
 * (lane, forwarder, period) — find-or-create against the partial
 * UNIQUE(lane_id, forwarder_id, period) — then APPEND their (possibly multiple) rate rows.
 * Independent rows insert rate rows directly with no acknowledgement (there is no
 * demand to acknowledge) and null lane_id/submission_id/period.
 */
export async function submitRates(rows) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  const laneLinked = rows.filter((r) => r.laneId)
  const independent = rows.filter((r) => !r.laneId)
  if (laneLinked.length === 0 && independent.length === 0) {
    return { error: new Error('No rates to submit') }
  }

  // shared shape for a rate row; lane_id/submission_id/period default to null (independent).
  // `carrier` is a single resolved code (the row is fanned out across carriersOf upstream).
  const buildRate = (r, { submissionId = null, laneId = null, period = null }, carrier = null) => ({
    submission_id: submissionId,
    lane_id: laneId,
    forwarder_id: forwarderId,
    provider_id: providerId,
    period,
    pol: r.pol || null,
    pod: r.pod || null,
    last_cy: r.lastCy || null,
    fd: r.fd || null,
    // Part of the ocean rate's identity — blank resolves to the 40' HC standard on write so the
    // stored value is never null (BIDDING.md §6).
    container_type: normalizeContainerType(r.containerType),
    carrier: carrier || null,
    rate_amount: toNumber(r.rate),
    free_days: toNumber(r.freeDays),
    valid_until: toDateString(r.validUntil),
    notes: r.remarks || null,
  })

  let count = 0

  // ── lane-linked: one acknowledgement per (lane, forwarder, period), then append rates
  const byLane = new Map()
  for (const r of laneLinked) {
    if (!byLane.has(r.laneId)) byLane.set(r.laneId, [])
    byLane.get(r.laneId).push(r)
  }
  for (const [laneId, laneRows] of byLane) {
    const period = laneRows[0].period

    let submissionId
    const { data: existing, error: findErr } = await supabase
      .from('rate_submissions')
      .select('id')
      .eq('lane_id', laneId)
      .eq('forwarder_id', forwarderId)
      .eq('period', period)
      .maybeSingle()
    if (findErr) return { error: findErr }

    if (existing) {
      submissionId = existing.id
      // a prior skip becomes a submit; refresh the timestamp
      await supabase
        .from('rate_submissions')
        .update({ status: 'submitted', skip_reason: null, submitted_at: new Date().toISOString() })
        .eq('id', submissionId)
    } else {
      const { data: created, error: insErr } = await supabase
        .from('rate_submissions')
        .insert({ lane_id: laneId, forwarder_id: forwarderId, provider_id: providerId, period, status: 'submitted' })
        .select('id')
        .single()
      if (insErr) return { error: insErr }
      submissionId = created.id
    }

    const rateRows = laneRows.flatMap((r) =>
      carriersOf(r).map((c) => buildRate(r, { submissionId, laneId, period }, c)))
    const { error: ratesErr } = await supabase.from('rates').insert(rateRows)
    if (ratesErr) return { error: ratesErr }
    count += rateRows.length
  }

  // ── independent: no demand to acknowledge → insert rate rows directly
  if (independent.length > 0) {
    const rateRows = independent.flatMap((r) => carriersOf(r).map((c) => buildRate(r, {}, c)))
    const { error: indErr } = await supabase.from('rates').insert(rateRows)
    if (indErr) return { error: indErr }
    count += rateRows.length
  }

  return { error: null, count }
}

/**
 * Skip a lane — write a `skipped` acknowledgement (0 rates) for (lane, forwarder, period).
 * Clears the lane from "Lanes to fill" for the whole forwarder. PROVIDER_VIEW_MODEL §3.
 * Find-or-create against the partial UNIQUE(lane_id, forwarder_id, period), so a prior ack
 * is flipped to skipped rather than colliding.
 */
export async function skipLane(laneId, period, reason = null) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  const { data: existing, error: findErr } = await supabase
    .from('rate_submissions')
    .select('id')
    .eq('lane_id', laneId)
    .eq('forwarder_id', forwarderId)
    .eq('period', period)
    .maybeSingle()
  if (findErr) return { error: findErr }

  if (existing) {
    const { error } = await supabase
      .from('rate_submissions')
      .update({ status: 'skipped', skip_reason: reason, submitted_at: new Date().toISOString() })
      .eq('id', existing.id)
    return { error }
  }

  const { error } = await supabase
    .from('rate_submissions')
    .insert({ lane_id: laneId, forwarder_id: forwarderId, provider_id: providerId, period, status: 'skipped', skip_reason: reason })
  return { error }
}

/**
 * Un-skip a lane — delete the `skipped` acknowledgement so the lane returns to "Lanes to
 * fill". PROVIDER_VIEW_MODEL §3. Scoped to the caller's forwarder (RLS enforces it too).
 */
export async function unskipLane(laneId, period) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { forwarderId } = ident

  const { error } = await supabase
    .from('rate_submissions')
    .delete()
    .eq('lane_id', laneId)
    .eq('forwarder_id', forwarderId)
    .eq('period', period)
    .eq('status', 'skipped')
  return { error }
}
