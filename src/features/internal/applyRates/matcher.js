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
  Match one lane (unique POL + Final Destination) against the active rates.

  lane: { laneKey, pol, fd, ofqIds }
  ratesByPol: from indexRatesByPol()
  geo: { within(a, b, miles), route(a, b) } — resolve { ok:true, ... } | { ok:false, error }

  Two-stage qualification per candidate last CY (POL already text-matched):
    1. straight-line pre-filter (ST_DWithin) — cheap, kills far-away CYs
    2. real drayage route (HERE) — only for stage-1 survivors, capped per lane

  Returns EVERY yard that passes both stages, sorted by route miles ascending:
  qualified: [{ cyLabel, cyNorm, miles, rates }]. Which yards actually apply — and the
  per-OFQ already-applied skip — is decided later (user discards + outputCsv.js).
*/
export async function matchLane(lane, ratesByPol, geo) {
  const base = { laneKey: lane.laneKey, pol: lane.pol, fd: lane.fd, ofqIds: lane.ofqIds, qualified: [], errors: [] }

  if (!norm(lane.fd)) return { ...base, status: 'no_destination' }
  const candidates = ratesByPol.get(norm(lane.pol)) ?? []
  if (candidates.length === 0) return { ...base, status: 'no_pol_match' }

  // Group candidates by normalized last CY; blank CYs can't be distance-checked.
  const byCy = new Map()
  for (const r of candidates) {
    const cy = norm(r.last_cy)
    if (!cy) continue
    if (!byCy.has(cy)) byCy.set(cy, { label: r.last_cy, rates: [] })
    byCy.get(cy).rates.push(r)
  }
  if (byCy.size === 0) return { ...base, status: 'no_last_cy' }

  const errors = []

  // Stage 1 — straight-line pre-filter (parallel; geoBatch caps real concurrency)
  const cys = [...byCy.keys()]
  const stage1 = (await Promise.all(cys.map(async (cy) => {
    const { label } = byCy.get(cy)
    const res = await geo.within(label, lane.fd, getThresholds(cy).stage1WithinMiles)
    if (!res.ok) {
      errors.push(`within ${label}: ${res.error}`)
      return null
    }
    return res.within ? cy : null
  }))).filter(Boolean)

  if (stage1.length === 0) {
    return { ...base, status: errors.length === cys.length ? 'geo_error' : 'no_cy_in_range', errors }
  }

  // Stage 2 — drayage route for survivors, capped per lane (quota safety)
  const capped = stage1.slice(0, MAX_STAGE2_ROUTES_PER_OFQ)
  const passed = (await Promise.all(capped.map(async (cy) => {
    const { label, rates } = byCy.get(cy)
    const res = await geo.route(label, lane.fd)
    if (!res.ok) {
      errors.push(`route ${label}: ${res.error}`)
      return null
    }
    const miles = metersToMiles(res.distance_m)
    return miles < getThresholds(cy).stage2RouteMiles ? { cyLabel: label, cyNorm: cy, miles, rates } : null
  }))).filter(Boolean)

  if (passed.length === 0) {
    return { ...base, status: errors.length >= capped.length && errors.length > 0 ? 'geo_error' : 'no_cy_in_range', errors }
  }

  passed.sort((a, b) => a.miles - b.miles)
  return { ...base, status: 'matched', qualified: passed, errors }
}
