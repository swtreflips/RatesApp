/*
  Drayage Analytics — pure Layer 1 computation (DRAYAGE_ANALYTICS.md §3–§4). No I/O:
  geo results and Supabase rows come in as plain data, so every rule here is testable.

  INTERNAL-ONLY (§1): $/mile and $/hour are the buyer's should-cost model — nothing in this
  module (or the page that uses it) may ever be rendered on a forwarder-facing surface.

  `norm` is the load-bearing piece: rates are grouped into lanes ONLY by their normalized
  (last_cy_cfs, final_destination) strings — kept byte-for-byte identical to the other
  features' norm (applyRates/matcher.js, bookings/matching.js; per-feature copy by convention).
*/

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** The grouping key: one physical route = one lane, however many forwarders quote it. */
export const laneKey = (lastCy, fd) => `${norm(lastCy)}|${norm(fd)}`

export const metersToMiles = (m) => m / 1609.344

/** Unique lanes among `rates` (label fields from the first rate seen), for the geo batch. */
export function dedupeLanes(rates) {
  const map = new Map()
  for (const r of rates ?? []) {
    const k = laneKey(r.last_cy_cfs, r.final_destination)
    if (!map.has(k)) map.set(k, { key: k, a: r.last_cy_cfs, b: r.final_destination })
  }
  return [...map.values()]
}

/**
 * A `drayage_rate_benchmarks` insert row for one rate on a routed lane — or null when it
 * can't be computed (zero/invalid distance/duration/total). §4's formulas; cents precision.
 */
export function benchmarkOf(rate, route) {
  const distance = Number(route?.distance_m)
  const duration = Number(route?.duration_s)
  const total = Number(rate?.total_rate)
  const miles = metersToMiles(distance)
  const hours = duration / 3600
  if (!(miles > 0) || !(hours > 0) || !Number.isFinite(total)) return null
  return {
    rate_id: rate.id,
    distance_m: distance,
    duration_s: duration,
    cost_per_mile: Math.round((total / miles) * 100) / 100,
    cost_per_hour: Math.round((total / hours) * 100) / 100,
  }
}

const cpmOf = (row) => (row.benchmark ? Number(row.benchmark.cost_per_mile) : null)

/**
 * Rates + their benchmarks → per-lane spread groups (§4's Layer 1 view).
 * Rows within a lane: $/mile ascending (unbenchmarked last). Lanes: multi-forwarder first
 * (the spread IS the point), then by label.
 *
 * @returns {{ key, label, distance_m, duration_s, rows: [{rate, benchmark}], min, max, avg }[]}
 */
export function groupByLane(rates, benchmarksById) {
  const lanes = new Map()
  for (const r of rates ?? []) {
    const k = laneKey(r.last_cy_cfs, r.final_destination)
    if (!lanes.has(k)) {
      lanes.set(k, {
        key: k,
        label: r.drayage_lane || `${r.last_cy_cfs ?? '—'} - ${r.final_destination ?? '—'}`,
        distance_m: null,
        duration_s: null,
        rows: [],
      })
    }
    const lane = lanes.get(k)
    const benchmark = benchmarksById.get(r.id) ?? null
    // all rates on a lane share the same physical route — first benchmark seen carries it
    if (benchmark && lane.distance_m == null) {
      lane.distance_m = Number(benchmark.distance_m)
      lane.duration_s = Number(benchmark.duration_s)
    }
    lane.rows.push({ rate: r, benchmark })
  }

  const out = []
  for (const lane of lanes.values()) {
    const cpms = lane.rows.map(cpmOf).filter((v) => v != null)
    lane.min = cpms.length ? Math.min(...cpms) : null
    lane.max = cpms.length ? Math.max(...cpms) : null
    lane.avg = cpms.length ? cpms.reduce((a, b) => a + b, 0) / cpms.length : null
    lane.rows.sort((a, b) =>
      (cpmOf(a) ?? Infinity) - (cpmOf(b) ?? Infinity)
      || (Number(a.rate.total_rate) || 0) - (Number(b.rate.total_rate) || 0))
    out.push(lane)
  }
  out.sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label))
  return out
}
