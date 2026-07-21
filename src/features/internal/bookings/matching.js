/*
  Bookings — pure matching helpers (no I/O, unit-testable).

  The one load-bearing thing here is `norm`: ocean options (from the OFQ file) and drayage rates
  (from our DB) are paired ONLY by their normalized (Last CY, Final Destination) strings. Both
  sides are free text, so the normalization must be identical to the rest of the app's — trim,
  lowercase, collapse internal whitespace — or the same real lane silently fails to match (the
  ERP-data risk documented in DRAYAGE_ANALYTICS.md §3a). Kept byte-for-byte the same as
  applyRates/matcher.js's `norm`.
*/

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** The join key between an ocean option and the drayage rates that complete it. */
export const laneKey = (lastCy, fd) => `${norm(lastCy)}|${norm(fd)}`

/** '$2,432.00' | '2432' | 2432 → 2432 ; blank / garbage → null. */
export const toNum = (v) => {
  if (v == null || v === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** CURRENT drayage rates → Map<laneKey, rate[]> so each ocean option is an O(1) lookup. */
export function indexDrayageByLane(rates) {
  const byLane = new Map()
  for (const r of rates ?? []) {
    const k = laneKey(r.last_cy_cfs, r.final_destination)
    if (!byLane.has(k)) byLane.set(k, [])
    byLane.get(k).push(r)
  }
  return byLane
}

/** Grand total = ocean rate + drayage `total_rate` (§6d). Either missing → null (can't total). */
export function grandTotal(oceanRate, drayage) {
  const o = toNum(oceanRate)
  const d = toNum(drayage?.total_rate)
  return o == null || d == null ? null : o + d
}
