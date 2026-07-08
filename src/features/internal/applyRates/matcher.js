/*
  Apply Rates — pure matching engine. No I/O: geo calls are injected (see geoBatch.js),
  Supabase rows come in as plain data, so every rule here is unit-testable.

  The matching unit is the LANE — a unique (POL, Final Destination) pair shared by one
  or more OFQs. A lane's result is EVERY yard that passes both geo stages (sorted by
  drayage miles ascending); the user picks which ones to apply in the review matrix,
  and the per-OFQ already-applied skip happens at output build (outputCsv.js).

  Identity: a rate is unique per (Forwarder, POL, POD, Last CY, Carrier, Rate, Valid Until).
  Both DB rates and the input file's already-applied rows are hashed through rateKey() so
  they compare equal despite formatting drift ($2,432.00 vs 2432; 7/29/2026 vs 2026-07-29).
*/

import { getThresholds, MAX_STAGE2_ROUTES_PER_OFQ } from './config'

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// '2,432.00' | '$2432' | 2432 → '2432.00'; blank/garbage → ''
export const normRate = (v) => {
  const s = String(v ?? '').replace(/[$,\s]/g, '')
  if (s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? n.toFixed(2) : ''
}

// 'M/D/YYYY' (input file) and 'YYYY-MM-DD' (DB) → 'YYYY-MM-DD'. String parsing only:
// `new Date('YYYY-MM-DD')` is UTC midnight and can shift a day in local time.
export const normDate = (v) => {
  if (v == null) return ''
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  }
  const s = String(v).trim()
  if (!s) return ''
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3]
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
  }
  return s.toLowerCase() // unknown format — key it as-is rather than dropping it
}

export const rateKey = ({ forwarder, pol, pod, lastCy, carrier, rate, validUntil }) =>
  [norm(forwarder), norm(pol), norm(pod), norm(lastCy), norm(carrier), normRate(rate), normDate(validUntil)].join('|')

// DB rate row (fetchActiveRates shape) → uniqueness key
export const keyFromDbRate = (r) => rateKey({
  forwarder: r.forwarder?.name,
  pol: r.pol,
  pod: r.pod,
  lastCy: r.last_cy,
  carrier: r.carrier,
  rate: r.rate_amount,
  validUntil: r.valid_until,
})

// Rows arrive created_at DESC, so keeping the first occurrence per key keeps the newest.
export function dedupeRates(rates) {
  const seen = new Set()
  const out = []
  for (const r of rates) {
    const k = keyFromDbRate(r)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(r)
  }
  return out
}

// Deduped rates → Map<normalized POL, rates[]> for candidate lookup.
export function indexRatesByPol(rates) {
  const byPol = new Map()
  for (const r of rates) {
    const k = norm(r.pol)
    if (!k) continue
    if (!byPol.has(k)) byPol.set(k, [])
    byPol.get(k).push(r)
  }
  return byPol
}

export const metersToMiles = (m) => m / 1609.344

// Lane identity — THE key shared by inputCsv (deriveLanes), outputCsv (buildOutputRows)
// and the review matrix, so a lane never means two different things.
export const laneKeyOf = (pol, fd) => `${norm(pol)}|${norm(fd)}`

/*
  Match ALL lanes with exactly two geo round trips (batch endpoints):
    Phase A — every lane's candidate (CY, FD) pairs, deduped job-wide → geo.within()
    Phase B — stage-1 survivors, per-lane cap applied first, deduped → geo.route()

  geo: createBatchGeo() — { within(pairs), route(pairs) } resolving index-aligned
  arrays of { ok:true, ... } | { ok:false, error }; never rejects.

  Per-lane logic, statuses, and the result shape are identical to matchLane —
  the review matrix and outputCsv consume the output unchanged.
*/
export async function matchLanesBatch(lanes, ratesByPol, geo) {
  // Phase 0 — pure per-lane prep; lanes that can't be geo-checked resolve immediately.
  const prep = lanes.map((lane) => {
    const base = { laneKey: lane.laneKey, pol: lane.pol, fd: lane.fd, ofqIds: lane.ofqIds, qualified: [], errors: [] }
    if (!norm(lane.fd)) return { done: { ...base, status: 'no_destination' } }
    const candidates = ratesByPol.get(norm(lane.pol)) ?? []
    if (candidates.length === 0) return { done: { ...base, status: 'no_pol_match' } }

    const byCy = new Map()
    for (const r of candidates) {
      const cy = norm(r.last_cy)
      if (!cy) continue
      if (!byCy.has(cy)) byCy.set(cy, { label: r.last_cy, rates: [] })
      byCy.get(cy).rates.push(r)
    }
    if (byCy.size === 0) return { done: { ...base, status: 'no_last_cy' } }

    return { lane, base, byCy, errors: [] }
  })
  const active = () => prep.filter((p) => !p.done)

  // Phase A — job-wide deduped within pairs (threshold is part of the identity).
  const withinPairs = new Map() // `${cyNorm}|${fdNorm}|${miles}` → { a: cyLabel, b: fd, miles }
  for (const p of active()) {
    for (const [cy, { label }] of p.byCy) {
      const miles = getThresholds(cy).stage1WithinMiles
      const key = `${cy}|${norm(p.lane.fd)}|${miles}`
      if (!withinPairs.has(key)) withinPairs.set(key, { a: label, b: p.lane.fd, miles })
    }
  }
  const withinKeys = [...withinPairs.keys()]
  const withinRes = await geo.within([...withinPairs.values()])
  const withinByKey = new Map(withinKeys.map((k, i) => [k, withinRes[i]]))

  for (const p of active()) {
    p.stage1 = []
    for (const [cy, { label }] of p.byCy) {
      const res = withinByKey.get(`${cy}|${norm(p.lane.fd)}|${getThresholds(cy).stage1WithinMiles}`)
      if (!res.ok) {
        p.errors.push(`within ${label}: ${res.error}`)
        continue
      }
      if (res.within) p.stage1.push(cy)
    }
    if (p.stage1.length === 0) {
      p.done = { ...p.base, status: p.errors.length === p.byCy.size ? 'geo_error' : 'no_cy_in_range', errors: p.errors }
    }
  }

  // Phase B — per-lane cap FIRST (quota safety, same as matchLane), then dedupe.
  const routePairs = new Map() // `${cyNorm}|${fdNorm}` → { a: cyLabel, b: fd }
  for (const p of active()) {
    p.capped = p.stage1.slice(0, MAX_STAGE2_ROUTES_PER_OFQ)
    for (const cy of p.capped) {
      const key = `${cy}|${norm(p.lane.fd)}`
      if (!routePairs.has(key)) routePairs.set(key, { a: p.byCy.get(cy).label, b: p.lane.fd })
    }
  }
  const routeKeys = [...routePairs.keys()]
  const routeRes = await geo.route([...routePairs.values()])
  const routeByKey = new Map(routeKeys.map((k, i) => [k, routeRes[i]]))

  for (const p of active()) {
    const passed = []
    for (const cy of p.capped) {
      const { label, rates } = p.byCy.get(cy)
      const res = routeByKey.get(`${cy}|${norm(p.lane.fd)}`)
      if (!res.ok) {
        p.errors.push(`route ${label}: ${res.error}`)
        continue
      }
      const miles = metersToMiles(res.distance_m)
      if (miles < getThresholds(cy).stage2RouteMiles) passed.push({ cyLabel: label, cyNorm: cy, miles, rates })
    }
    if (passed.length === 0) {
      p.done = { ...p.base, status: p.errors.length >= p.capped.length && p.errors.length > 0 ? 'geo_error' : 'no_cy_in_range', errors: p.errors }
    } else {
      passed.sort((a, b) => a.miles - b.miles)
      p.done = { ...p.base, status: 'matched', qualified: passed, errors: p.errors }
    }
  }

  return prep.map((p) => p.done)
}
