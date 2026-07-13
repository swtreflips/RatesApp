/*
  Apply Rates — qualification thresholds + quota-safety knobs.

  Tuning happens HERE, not in the engine: matcher.js reads distances only through
  getThresholds(). Thresholds are tiered by yard group (RATES.md operational spec):
  yards with sparse regional coverage get a big catchment (the West is served by a
  handful of yards — LA effectively covers Phoenix/Nevada/New Mexico), clustered
  midwest/east yards get the standard one. Stage 1 (straight-line) and stage 2
  (drayage route) intentionally share the group's number — a road route is always
  ≥ the straight line, so an equal pre-filter can never wrongly exclude a yard.
*/

export const LONG_DISTANCE_MILES = 400
export const STANDARD_MILES = 245

/* ── TUNING: move a yard in/out of this list to change its group ──────────────
   Yards listed here qualify rates up to LONG_DISTANCE_MILES; every other yard
   uses STANDARD_MILES. Case/extra spacing don't matter ("Los Angeles, CA" and
   "los angeles,  ca" both match), but keep the "City, ST" comma format. */
export const LONG_DISTANCE_YARDS = [
  'Seattle, WA',
  'Tacoma, WA',
  'Oakland, CA',
  'Los Angeles, CA',
  'Long Beach, CA',
  'Denver, CO',
  'Minneapolis, MN',
  'New York, NY',
  'Norfolk, VA',
]

// Optional per-yard fine-tuning ON TOP of the groups (highest precedence), keyed by
// normalized name. Example:
//   'chicago, il': { stage1WithinMiles: 300, stage2RouteMiles: 300 },
export const CY_THRESHOLD_OVERRIDES = {}

// Quota safety: never route-check more than this many candidate CYs per lane.
export const MAX_STAGE2_ROUTES_PER_OFQ = 10

// Local normalizer — matcher.js's norm() can't be imported here (matcher imports
// this module; that would be a circular init). Keep the two in sync.
const normKey = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

const LONG_SET = new Set(LONG_DISTANCE_YARDS.map(normKey))

export function getThresholds(lastCyNorm) {
  const groupMiles = LONG_SET.has(lastCyNorm) ? LONG_DISTANCE_MILES : STANDARD_MILES
  const o = CY_THRESHOLD_OVERRIDES[lastCyNorm] ?? {}
  return {
    stage1WithinMiles: o.stage1WithinMiles ?? groupMiles,
    stage2RouteMiles: o.stage2RouteMiles ?? groupMiles,
  }
}
