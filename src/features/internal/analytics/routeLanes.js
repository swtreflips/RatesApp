/*
  Drayage Analytics — thin batch-geo adapter over src/lib/geo.js's routeBatch (DRAYAGE_ANALYTICS.md
  §3). Same discipline as applyRates/geoBatch.js, minus the within phase: one batched request over
  the unique lanes, per-pair failures normalized to a human-readable error, never rejects. The
  brain already chunks + caches lanes server-side, so a re-run is cheap.
*/

import { routeBatch } from '../../../lib/geo'

// "location not found: coppell, tx" beats a bare no_result on the error line.
const missingLabel = (r) => {
  const missing = [r.a_found === false ? r.a : null, r.b_found === false ? r.b : null].filter(Boolean)
  return missing.length ? `location not found: ${missing.join(', ')}` : 'no_result'
}

/**
 * Route the unique lanes. `lanes`: [{ key, a, b }] → Map<key, result>, where result is
 * { ok:true, distance_m, duration_s, cached } | { ok:false, error }. Also returns per-run stats.
 */
export async function routeLanes(lanes) {
  const stats = { pairs: lanes.length, cacheHits: 0, errors: 0 }
  if (lanes.length === 0) return { byLane: new Map(), stats }

  let results
  try {
    results = await routeBatch(lanes.map(({ a, b }) => ({ a, b })))
  } catch (e) {
    stats.errors = lanes.length
    return {
      byLane: new Map(lanes.map((l) => [l.key, { ok: false, error: e.message }])),
      stats,
    }
  }

  const byLane = new Map()
  lanes.forEach((lane, i) => {
    const r = results[i]
    let mapped
    if (r?.ok) {
      mapped = { ok: true, distance_m: r.distance_m, duration_s: r.duration_s, cached: r.cached }
      if (r.cached) stats.cacheHits += 1
    } else {
      mapped = { ok: false, error: r?.detail === 'not_found' ? missingLabel(r) : (r?.detail ?? r?.error ?? 'unknown') }
      stats.errors += 1
    }
    byLane.set(lane.key, mapped)
  })
  return { byLane, stats }
}
