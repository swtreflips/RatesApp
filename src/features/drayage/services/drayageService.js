import { supabase } from '../../../lib/supabase'

/*
  Drayage data access (DRAY.md §6). Differs from ocean in three structural ways:

  1. OPEN-ENDED RATES (§6b): no valid_until. One `current` rate per (forwarder, lane); a new
     rate SUPERSEDES the old (status flip + insert — enforced by drayage_rates_current_uq).
     Age is display-only, derived from confirmed_at (stalenessOf).
  2. NO PERIOD: acks are one per (lane, forwarder) — a refresh request is a NEW lane row.
  3. FUEL MATH IN THE DB (§6d): we store only what the user typed (rate + pct and/or $);
     fuel_surcharge_amount / fuel_surcharge_pct_eff / total_rate are generated columns —
     the client never computes money it persists.

  The request lane keeps a TTL (expires_at) purely as flow control — lanes roll off the
  forwarder's "to fill" view; their rates live on indefinitely.
*/

/* ── staleness (§6b) — display-only cues, never enforced ─────────────── */

const MONTH_MS = 30.44 * 86_400_000

/** Months after which a rate stops counting as fresh — drayage prices move with fuel/market
    roughly quarterly, so the question "does this still stand?" becomes fair at 3 months. */
export const FRESH_MONTHS = 3
const STALE_MONTHS = 12

/** 'fresh' < 3 mo · 'aging' 3–12 mo · 'stale' > 12 mo (from confirmed_at). */
export function stalenessOf(confirmedAt) {
  if (!confirmedAt) return null
  const months = (Date.now() - new Date(confirmedAt).getTime()) / MONTH_MS
  if (months < FRESH_MONTHS) return 'fresh'
  if (months < STALE_MONTHS) return 'aging'
  return 'stale'
}

/** A rate is "in question" — and therefore shows Confirm / Update — when it has aged past fresh
    or internal explicitly asked for a re-quote. Fresh + unasked rows stay quiet (no redundant
    Confirm on a rate provided yesterday). */
export const isInQuestion = (rate) =>
  Boolean(rate?.refreshRequested) || ['aging', 'stale'].includes(stalenessOf(rate?.confirmed_at))

/* ── shared helpers ──────────────────────────────────────────────────── */

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

function toNumber(v) {
  return v === '' || v == null ? null : Number(v)
}

// Date Received, as typed or picked — null on blank/unparseable (mirrors submissionService's
// toDateString). Kept OUT of the insert object entirely when null (see buildRate) rather than
// passed as null, since provided_at is NOT NULL DEFAULT current_date: an explicit null would
// violate the constraint, while an omitted key lets the default apply.
function toDateString(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Fuel % as typed → fraction. Forwarders think "34", the DB stores 0.34 (§6d). */
function toPctFraction(v) {
  const n = toNumber(v)
  if (n == null) return null
  return n > 1 ? n / 100 : n
}

/** Map a grid row + identity into a drayage_rates insert (stored columns only). */
function buildRate(r, { forwarderId, providerId, submissionId = null, laneId = null }) {
  const providedAt = toDateString(r.providedAt)
  return {
    submission_id: submissionId,
    lane_id: laneId,
    forwarder_id: forwarderId,
    provider_id: providerId,
    last_cy_cfs: r.origin || null,
    final_destination: r.destination || null,
    dest_zip: r.zip || null,
    rate: toNumber(r.rate),
    fuel_surcharge_pct: toPctFraction(r.fuelPct),
    fuel_surcharge: toNumber(r.fuelAmount),
    toll_fee: toNumber(r.tollFee),
    pre_pull_fee: toNumber(r.prePullFee),
    pier_pass_fee: toNumber(r.pierPassFee),
    clean_truck_fee: toNumber(r.cleanTruckFee),
    drop_fee: toNumber(r.dropFee),
    chassis_fee: toNumber(r.chassisFee),
    min_chassis_days: toNumber(r.minChassisDays),
    chassis_days_included: toNumber(r.chassisDaysIncluded),
    storage_fee_per_day: toNumber(r.storagePerDay),
    notes: r.notes || null,
    // omitted (not null) when blank — DB default fills in today (§6a Date Received)
    ...(providedAt ? { provided_at: providedAt } : {}),
  }
}

/**
 * Supersede-then-insert (§6b): for each new rate, flip the company's existing `current` rate
 * on the same lane to `superseded`, then insert the new row as `current`. The partial unique
 * index makes any missed supersession fail loudly instead of silently double-pricing a lane.
 */
async function insertWithSupersession(rateRows) {
  let count = 0
  for (const row of rateRows) {
    const { error: supErr } = await supabase
      .from('drayage_rates')
      .update({ status: 'superseded' })
      .eq('forwarder_id', row.forwarder_id)
      .eq('last_cy_cfs', row.last_cy_cfs)
      .eq('final_destination', row.final_destination)
      .eq('status', 'current')
    if (supErr) return { error: supErr, count }

    const { error: insErr } = await supabase.from('drayage_rates').insert(row)
    if (insErr) return { error: insErr, count }
    count++
  }
  return { error: null, count }
}

/* ── forwarder: lanes to fill ────────────────────────────────────────── */

/** Open drayage lanes this company hasn't acted on (anti-join keyed on the COMPANY). */
export async function fetchDrayageLanes() {
  const { data: lanes, error } = await supabase
    .from('drayage_request_lanes')
    .select('id, last_cy_cfs, final_destination, dest_zip, notes, kind, posted_at, expires_at')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
  if (error) return { lanes: [], error }

  const { data: acks, error: ackErr } = await supabase
    .from('drayage_submissions')
    .select('lane_id') // RLS scopes to the caller's company
  if (ackErr) return { lanes: [], error: ackErr }

  const acted = new Set((acks ?? []).map((a) => a.lane_id))
  return { lanes: (lanes ?? []).filter((l) => !acted.has(l.id)), error: null }
}

/**
 * Forwarder submit — lane-linked rows get one `submitted` ack per (lane, company), then their
 * rates land via supersession. Independent rows (no laneId) are proactive rates (§6c).
 */
export async function submitDrayageRates(rows) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  return submitRowsAs(rows, () => ({ forwarderId, providerId }))
}

/** Skip a lane — `skipped` ack clears it from "to fill" for the whole company. */
export async function skipDrayageLane(laneId, reason = null) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  const { data: existing, error: findErr } = await supabase
    .from('drayage_submissions')
    .select('id')
    .eq('lane_id', laneId)
    .eq('forwarder_id', forwarderId)
    .maybeSingle()
  if (findErr) return { error: findErr }

  if (existing) {
    const { error } = await supabase
      .from('drayage_submissions')
      .update({ status: 'skipped', skip_reason: reason, submitted_at: new Date().toISOString() })
      .eq('id', existing.id)
    return { error }
  }
  const { error } = await supabase
    .from('drayage_submissions')
    .insert({ lane_id: laneId, forwarder_id: forwarderId, provider_id: providerId, status: 'skipped', skip_reason: reason })
  return { error }
}

export async function unskipDrayageLane(laneId) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { error } = await supabase
    .from('drayage_submissions')
    .delete()
    .eq('lane_id', laneId)
    .eq('forwarder_id', ident.forwarderId)
    .eq('status', 'skipped')
  return { error }
}

/* ── forwarder: my current rates (open-ended) ────────────────────────── */

/**
 * The company's current rates, each flagged with `refreshRequested` when internal has an open
 * re-quote request pointing at it (kind='refresh', refresh_of = the rate). Selects every STORED
 * column so "Update price" can carry the untouched fields (accessorials, chassis days…) forward
 * onto the superseding row instead of silently dropping them.
 */
export async function fetchMyDrayageRates() {
  const { data, error } = await supabase
    .from('drayage_rates')
    .select('id, drayage_lane, last_cy_cfs, final_destination, dest_zip, rate, fuel_surcharge_pct, fuel_surcharge, fuel_surcharge_amount, fuel_surcharge_pct_eff, total_rate, toll_fee, pre_pull_fee, pier_pass_fee, clean_truck_fee, drop_fee, chassis_fee, min_chassis_days, chassis_days_included, storage_fee_per_day, provided_at, confirmed_at, notes')
    .eq('status', 'current')
    .order('provided_at', { ascending: false })
  if (error) return { rates: [], error }

  // Open re-quote asks → the explicit "this rate is in question" signal (overrides age).
  const { data: refreshLanes } = await supabase
    .from('drayage_request_lanes')
    .select('refresh_of')
    .eq('kind', 'refresh')
    .not('refresh_of', 'is', null)
    .gt('expires_at', new Date().toISOString())
  const asked = new Set((refreshLanes ?? []).map((l) => l.refresh_of))

  return { rates: (data ?? []).map((r) => ({ ...r, refreshRequested: asked.has(r.id) })), error: null }
}

/** Re-confirm (§6b): "this price still stands" — bumps confirmed_at, resets the age cue. */
export async function confirmDrayageRate(rateId) {
  const { error } = await supabase
    .from('drayage_rates')
    .update({ confirmed_at: new Date().toISOString().slice(0, 10) })
    .eq('id', rateId)
  return { error }
}

/**
 * "My price changed" (§6b): supersede this rate with an edited copy. Every stored field is carried
 * forward from the existing row and only `changes` are applied, so accessorials aren't lost. Uses
 * the same supersede-then-insert path as a normal submission — never an in-place edit, so the old
 * price stays as history and the new row gets a fresh provided_at.
 */
export async function updateDrayageRate(rate, changes) {
  const ident = await getIdentity()
  if (ident.error) return { error: ident.error }
  const { providerId, forwarderId } = ident

  const next = {
    submission_id: null,
    lane_id: null,
    forwarder_id: forwarderId,
    provider_id: providerId,
    last_cy_cfs: rate.last_cy_cfs,
    final_destination: rate.final_destination,
    dest_zip: rate.dest_zip ?? null,
    // carried forward untouched
    toll_fee: rate.toll_fee, pre_pull_fee: rate.pre_pull_fee, pier_pass_fee: rate.pier_pass_fee,
    clean_truck_fee: rate.clean_truck_fee, drop_fee: rate.drop_fee, chassis_fee: rate.chassis_fee,
    min_chassis_days: rate.min_chassis_days, chassis_days_included: rate.chassis_days_included,
    // editable in the modal
    rate: toNumber(changes.rate),
    fuel_surcharge_pct: toPctFraction(changes.fuelPct),
    fuel_surcharge: toNumber(changes.fuelAmount),
    storage_fee_per_day: toNumber(changes.storagePerDay),
    notes: changes.notes || null,
  }

  const { error } = await insertWithSupersession([next])
  return { error }
}

/* ── internal: request side ──────────────────────────────────────────── */

/** Post a drayage request batch (batch tagged service='drayage'). */
export async function postDrayageRequestBatch(lanes, requesterId) {
  const { data: batch, error: batchError } = await supabase
    .from('rate_request_batches')
    .insert({ requester_id: requesterId, service: 'drayage' })
    .select()
    .single()
  if (batchError) return { batch: null, lanes: null, error: batchError }

  const laneRows = lanes.map((l) => ({
    batch_id: batch.id,
    last_cy_cfs: l.origin,
    final_destination: l.destination,
    dest_zip: l.zip || null,
    notes: l.notes || null,
    kind: l.kind || 'new',
    refresh_of: l.refreshOf || null,
  }))
  const { data: insertedLanes, error: lanesError } = await supabase
    .from('drayage_request_lanes')
    .insert(laneRows)
    .select()
  if (lanesError) return { batch, lanes: null, error: lanesError }
  return { batch, lanes: insertedLanes, error: null }
}

/** Internal Open Drayage Requests — active lanes + count of rates received on each. */
export async function fetchDrayageOpenRequests() {
  const { data, error } = await supabase
    .from('drayage_request_lanes')
    // Disambiguate the embed: there are TWO FKs between these tables (drayage_rates.lane_id →
    // lanes, and lanes.refresh_of → drayage_rates). `!lane_id` picks the "rates received on this
    // lane" relationship (SUPABASE.md §4).
    .select('id, last_cy_cfs, final_destination, dest_zip, notes, kind, posted_at, expires_at, drayage_rates!lane_id(count)')
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
  return { lanes: data ?? [], error }
}

/**
 * Refresh request (§6b): re-quote a lane we already have a rate for. Creates a one-lane
 * batch with kind='refresh' + refresh_of → the existing rate. The forwarder answers by
 * re-confirming or submitting a new rate (which supersedes).
 */
export async function requestDrayageRefresh(rate, requesterId) {
  return postDrayageRequestBatch([{
    origin: rate.last_cy_cfs,
    destination: rate.final_destination,
    zip: rate.dest_zip,
    notes: `Refresh request — current rate ${rate.total_rate ?? rate.rate} provided ${rate.provided_at}`,
    kind: 'refresh',
    refreshOf: rate.id,
  }], requesterId)
}

/* ── internal: rates view (all forwarders) ───────────────────────────── */

export async function fetchDrayageRates({ scope = 'current' } = {}) {
  let query = supabase
    .from('drayage_rates')
    .select('id, lane_id, drayage_lane, last_cy_cfs, final_destination, dest_zip, rate, fuel_surcharge_amount, fuel_surcharge_pct_eff, total_rate, storage_fee_per_day, provided_at, confirmed_at, status, notes, forwarder:forwarders(name)')
  if (scope === 'current') query = query.eq('status', 'current')
  const { data, error } = await query.order('provided_at', { ascending: false })
  return { rates: data ?? [], error }
}

/* ── internal: upload on behalf ──────────────────────────────────────── */

/**
 * Record drayage rates on behalf of forwarders (mirrors recordRatesService): the internal
 * user picks the forwarder per row; provider_id = the internal user. Same ack + supersession
 * machinery as the forwarder path.
 */
export async function submitDrayageRatesOnBehalf(rows) {
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) return { error: new Error('Not signed in') }
  if (rows.some((r) => !r.forwarderId)) {
    return { error: new Error('Pick a forwarder for every row before submitting') }
  }
  return submitRowsAs(rows, (r) => ({ forwarderId: r.forwarderId, providerId: userId }))
}

/* ── shared submit engine (forwarder + on-behalf paths) ──────────────── */

async function submitRowsAs(rows, identityFor) {
  const filled = rows.filter((r) => r.rate !== '' && r.rate != null)
  if (filled.length === 0) return { error: new Error('No rates to submit') }

  const laneLinked = filled.filter((r) => r.laneId)
  const independent = filled.filter((r) => !r.laneId)
  let count = 0

  // lane-linked: one ack per (lane, company) — find-or-create, then rates via supersession
  const byKey = new Map()
  for (const r of laneLinked) {
    const { forwarderId } = identityFor(r)
    const key = `${r.laneId}|${forwarderId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }

  for (const [, groupRows] of byKey) {
    const { forwarderId, providerId } = identityFor(groupRows[0])
    const laneId = groupRows[0].laneId

    let submissionId
    const { data: existing, error: findErr } = await supabase
      .from('drayage_submissions')
      .select('id')
      .eq('lane_id', laneId)
      .eq('forwarder_id', forwarderId)
      .maybeSingle()
    if (findErr) return { error: findErr }

    if (existing) {
      submissionId = existing.id
      await supabase
        .from('drayage_submissions')
        .update({ status: 'submitted', skip_reason: null, submitted_at: new Date().toISOString() })
        .eq('id', submissionId)
    } else {
      const { data: created, error: insErr } = await supabase
        .from('drayage_submissions')
        .insert({ lane_id: laneId, forwarder_id: forwarderId, provider_id: providerId, status: 'submitted' })
        .select('id')
        .single()
      if (insErr) return { error: insErr }
      submissionId = created.id
    }

    const rateRows = groupRows.map((r) =>
      buildRate(r, { ...identityFor(r), submissionId, laneId }))
    const { error, count: n } = await insertWithSupersession(rateRows)
    if (error) return { error }
    count += n
  }

  // independent: proactive rates, no ack (§6c)
  if (independent.length > 0) {
    const rateRows = independent.map((r) => buildRate(r, identityFor(r)))
    const { error, count: n } = await insertWithSupersession(rateRows)
    if (error) return { error }
    count += n
  }

  return { error: null, count }
}
