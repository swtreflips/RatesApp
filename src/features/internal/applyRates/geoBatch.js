/*
  Apply Rates — thin batch-geo adapter over src/lib/geo.js.

  The whole job's geo work is TWO POST requests (one within-batch, one route-batch);
  job-wide pair dedup happens in matcher.matchLanesBatch. This module's jobs:
  1. never reject — every element resolves { ok:true, ... } | { ok:false, error }
     (a whole-batch transport failure degrades to per-pair errors);
  2. normalize the brain's per-pair failure shapes (a_found/b_found:false, detail)
     into ok:false with a human-readable error — matcher's geo_error counting and
     the Notes column depend on it;
  3. tally stats for the review screen.
*/

import { withinBatch, routeBatch } from '../../../lib/geo'

// "location not found: coppell, tx" beats a bare no_result in the Notes column.
const missingLabel = (r) => {
  const missing = [r.a_found === false ? r.a : null, r.b_found === false ? r.b : null].filter(Boolean)
  return missing.length ? `location not found: ${missing.join(', ')}` : 'no_result'
}

export function createBatchGeo({ onPhase } = {}) {
  const stats = { withinPairs: 0, routePairs: 0, cacheHits: 0, errors: 0 }

  const run = async (label, fn, pairs, mapResult) => {
    if (pairs.length === 0) return []
    onPhase?.(label, pairs.length)
    try {
      const results = await fn(pairs)
      return results.map((r) => {
        const mapped = mapResult(r)
        if (!mapped.ok) stats.errors += 1
        else if (mapped.cached) stats.cacheHits += 1
        return mapped
      })
    } catch (e) {
      stats.errors += pairs.length
      return pairs.map(() => ({ ok: false, error: e.message }))
    }
  }

  return {
    // pairs: [{ a, b, miles }] → [{ ok, within, cached } | { ok:false, error }]
    within: (pairs) => {
      stats.withinPairs += pairs.length
      return run('within', withinBatch, pairs, (r) => {
        if (r.ok) return { ok: true, within: r.within, cached: r.cached }
        if (r.error === 'no_result') return { ok: false, error: missingLabel(r) }
        return { ok: false, error: r.error ?? 'unknown' }
      })
    },
    // pairs: [{ a, b }] → [{ ok, distance_m, duration_s, cached } | { ok:false, error }]
    route: (pairs) => {
      stats.routePairs += pairs.length
      return run('route', routeBatch, pairs, (r) => {
        if (r.ok) return { ok: true, distance_m: r.distance_m, duration_s: r.duration_s, cached: r.cached }
        if (r.detail === 'not_found') return { ok: false, error: missingLabel(r) }
        return { ok: false, error: r.detail ?? r.error ?? 'unknown' }
      })
    },
    stats,
  }
}
