/*
  Apply Rates — matching thresholds + quota-safety knobs.

  Tuning happens HERE, not in the engine: matcher.js reads thresholds only through
  getThresholds(), so per-CY overrides (RATES.md: <400 mi for major rail/port hubs,
  <245 mi for the rest) drop in later without touching the matching code.
*/

// Stage 1 — straight-line pre-filter (PostGIS ST_DWithin via the brain's /api/within).
export const STAGE1_WITHIN_MILES = 100

// Stage 2 — the real drayage truck route (HERE via /api/route) must be under this.
export const STAGE2_ROUTE_MILES = 100

// Quota safety: never route-check more than this many candidate CYs per lane.
export const MAX_STAGE2_ROUTES_PER_OFQ = 10

// Per-CY threshold overrides, keyed by NORMALIZED last CY (lowercase, single spaces).
// Example:
//   'los angeles, ca': { stage1WithinMiles: 400, stage2RouteMiles: 400 },
export const CY_THRESHOLD_OVERRIDES = {}

export function getThresholds(lastCyNorm) {
  const o = CY_THRESHOLD_OVERRIDES[lastCyNorm] ?? {}
  return {
    stage1WithinMiles: o.stage1WithinMiles ?? STAGE1_WITHIN_MILES,
    stage2RouteMiles: o.stage2RouteMiles ?? STAGE2_ROUTE_MILES,
  }
}
