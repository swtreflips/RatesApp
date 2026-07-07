/*
  Apply Rates — pure matching engine. No I/O: geo calls are injected (see geoBatch.js),
  Supabase rows come in as plain data, so every rule here is unit-testable.

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

/*
  Match one OFQ against the active rates.

  ofq: { ofqId, pol, fd, appliedKeys: Set<rateKey> }
  ratesByPol: from indexRatesByPol()
  geo: { within(a, b, miles), route(a, b) } — resolve { ok:true, ... } | { ok:false, error }

  Two-stage qualification per candidate last CY (POL already text-matched):
    1. straight-line pre-filter (ST_DWithin) — cheap, kills far-away CYs
    2. real drayage route (HERE) — only for stage-1 survivors, capped per OFQ
  Winner = the closest qualifying CY by route miles; output = every deduped rate at
  that CY that is not already applied to this OFQ.
*/
export async function matchOfq(ofq, ratesByPol, geo) {
  const base = { ofqId: ofq.ofqId, pol: ofq.pol, fd: ofq.fd, bestCy: null, routeMiles: null, applied: [], errors: [] }

  if (!norm(ofq.fd)) return { ...base, status: 'no_destination' }
  const candidates = ratesByPol.get(norm(ofq.pol)) ?? []
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
    const res = await geo.within(label, ofq.fd, getThresholds(cy).stage1WithinMiles)
    if (!res.ok) {
      errors.push(`within ${label}: ${res.error}`)
      return null
    }
    return res.within ? cy : null
  }))).filter(Boolean)

  if (stage1.length === 0) {
    return { ...base, status: errors.length === cys.length ? 'geo_error' : 'no_cy_in_range', errors }
  }

  // Stage 2 — drayage route for survivors, capped per OFQ (quota safety)
  const capped = stage1.slice(0, MAX_STAGE2_ROUTES_PER_OFQ)
  const passed = (await Promise.all(capped.map(async (cy) => {
    const { label } = byCy.get(cy)
    const res = await geo.route(label, ofq.fd)
    if (!res.ok) {
      errors.push(`route ${label}: ${res.error}`)
      return null
    }
    const miles = metersToMiles(res.distance_m)
    return miles < getThresholds(cy).stage2RouteMiles ? { cy, miles } : null
  }))).filter(Boolean)

  if (passed.length === 0) {
    return { ...base, status: errors.length >= capped.length && errors.length > 0 ? 'geo_error' : 'no_cy_in_range', errors }
  }

  const best = passed.reduce((a, b) => (b.miles < a.miles ? b : a))
  const applied = byCy.get(best.cy).rates.filter((r) => !ofq.appliedKeys.has(keyFromDbRate(r)))

  return {
    ...base,
    status: applied.length ? 'matched' : 'all_already_applied',
    bestCy: byCy.get(best.cy).label,
    routeMiles: best.miles,
    applied,
    errors,
  }
}
