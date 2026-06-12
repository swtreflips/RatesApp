import { supabase } from '../../../lib/supabase'

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
    .select('id, pol, fd, container_type, container_count, period, posted_at, expires_at')
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

function toDateString(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function toNumber(v) {
  return v === '' || v == null ? null : Number(v)
}

/**
 * Submit provider rates against lanes.
 * @param {{ laneId: string, period: number, pol: string, fd: string, pod?: string,
 *           lastCy?: string, rate?: number|string, freeDays?: number|string,
 *           carrier?: string, validUntil?: Date|string, remarks?: string }[]} rows
 *   one entry per filled grid row (must carry laneId + period from the lane it answers).
 * @returns {{ error: Error|null, count?: number }}
 *
 * Per lane it ensures exactly one `submitted` acknowledgement (find-or-create, matching
 * the partial UNIQUE(lane_id, forwarder_id, period)), then APPENDS the rate rows.
 */
export async function submitRates(rows) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  // group filled rows by the lane they answer
  const byLane = new Map()
  for (const r of rows) {
    if (!r.laneId) continue
    if (!byLane.has(r.laneId)) byLane.set(r.laneId, [])
    byLane.get(r.laneId).push(r)
  }
  if (byLane.size === 0) return { error: new Error('No rates to submit') }

  let count = 0
  for (const [laneId, laneRows] of byLane) {
    const period = laneRows[0].period

    // find-or-create the acknowledgement (one per lane+forwarder+period)
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

    // append the rate rows (never delete prior bids)
    const rateRows = laneRows.map((r) => ({
      submission_id: submissionId,
      lane_id: laneId,
      forwarder_id: forwarderId,
      provider_id: providerId,
      period,
      pol: r.pol,
      pod: r.pod || null,
      last_cy: r.lastCy || null,
      fd: r.fd,
      carrier: r.carrier || null,
      rate_amount: toNumber(r.rate),
      free_days: toNumber(r.freeDays),
      valid_until: toDateString(r.validUntil),
      notes: r.remarks || null,
    }))
    const { error: ratesErr } = await supabase.from('rates').insert(rateRows)
    if (ratesErr) return { error: ratesErr }
    count += rateRows.length
  }

  return { error: null, count }
}
