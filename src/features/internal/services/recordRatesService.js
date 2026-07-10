import { supabase } from '../../../lib/supabase'

/*
  Internal "Upload Rates" — record rates on behalf of a forwarder.

  Unlike the forwarder submit (forwarder_id implicit from my_forwarder()), here the internal
  user picks the forwarder per row. Each written row is stamped:
    - forwarder_id = the chosen forwarder (whose rate it is — the isolation/identity line)
    - provider_id  = the internal user's uid (= who entered it; "recorded by us" is derivable
                     by joining provider_id → profiles.role)
  Lane-linked rows are grouped by (lane, forwarder) — different forwarders on one lane are
  different acknowledgements. Requires the internal-write RLS policies (plan.md §1).
*/

function toDateString(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function toNumber(v) {
  return v === '' || v == null ? null : Number(v)
}

// A row fans out into one rate per carrier; a carrier-less row still yields exactly one rate.
function carriersOf(r) {
  if (Array.isArray(r.carrier) && r.carrier.length > 0) return r.carrier
  if (typeof r.carrier === 'string' && r.carrier.trim() !== '') return [r.carrier.trim()]
  return [null]
}

/** The forwarder companies an internal user can record rates for (RLS: any authenticated read). */
export async function fetchForwarders() {
  const { data, error } = await supabase
    .from('forwarders')
    .select('id, name')
    .order('name')
  return { forwarders: data ?? [], error }
}

/**
 * Record rates on behalf of forwarders. Mirrors the forwarder `submitRates` shape but takes the
 * forwarder from each row (`forwarderId`) and stamps `provider_id` = the internal user.
 * @param {{ forwarderId: string, laneId?: string|null, period?: number|null, pol?, pod?, lastCy?,
 *           fd?, contract?, contractName?, rate?, freeDays?, carrier?: string[]|string, validUntil?, remarks? }[]} rows
 * @returns {{ error: Error|null, count?: number }}
 */
export async function submitRatesOnBehalf(rows) {
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) return { error: new Error('Not signed in') }

  const laneLinked = rows.filter((r) => r.laneId)
  const independent = rows.filter((r) => !r.laneId)
  if (laneLinked.length === 0 && independent.length === 0) {
    return { error: new Error('No rates to submit') }
  }

  // every written row must name a forwarder (that's the whole point of the on-behalf flow)
  if (rows.some((r) => !r.forwarderId)) {
    return { error: new Error('Pick a forwarder for every row before submitting') }
  }

  const buildRate = (r, { submissionId = null, laneId = null, period = null }, carrier = null) => ({
    submission_id: submissionId,
    lane_id: laneId,
    forwarder_id: r.forwarderId,
    provider_id: userId,
    period,
    pol: r.pol || null,
    pod: r.pod || null,
    last_cy: r.lastCy || null,
    fd: r.fd || null,
    contract: r.contract || null,
    contractname: r.contractName || null,  // DB column is lowercase (unquoted DDL)
    carrier: carrier || null,
    rate_amount: toNumber(r.rate),
    free_days: toNumber(r.freeDays),
    valid_until: toDateString(r.validUntil),
    notes: r.remarks || null,
  })

  let count = 0

  // ── lane-linked: one acknowledgement per (lane, forwarder, period), then append rates.
  // The forwarder is part of the uniqueness key — so a single lane carrying rates from several
  // forwarders yields one ack per forwarder (mirrors UNIQUE(lane_id, forwarder_id, period)).
  const byKey = new Map() // key = `${laneId}|${forwarderId}`
  for (const r of laneLinked) {
    const key = `${r.laneId}|${r.forwarderId}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }

  for (const [, groupRows] of byKey) {
    const { laneId, forwarderId, period } = groupRows[0]

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
        .insert({ lane_id: laneId, forwarder_id: forwarderId, provider_id: userId, period, status: 'submitted' })
        .select('id')
        .single()
      if (insErr) return { error: insErr }
      submissionId = created.id
    }

    const rateRows = groupRows.flatMap((r) =>
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
