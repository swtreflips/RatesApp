import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Loader2, RefreshCw, ArrowLeft, Route as RouteIcon, Truck, Award, TrendingUp, Gauge,
} from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { Toast } from '../../rates/rateGrid'
import { money } from '../../drayage/drayageGrid'
import { fetchDrayageRates } from '../../drayage/services/drayageService'
import { fetchBenchmarks, insertBenchmarks } from '../services/benchmarksService'
import { dedupeLanes, benchmarkOf, groupByLane, laneKey } from '../analytics/compute'
import { routeLanes } from '../analytics/routeLanes'

/*
  Drayage Analytics — Layer 1 (DRAYAGE_ANALYTICS.md): cross-sectional "today" benchmarking.
  Every current drayage rate gets a real $/mile · $/hour from its HERE truck route; presented as
  a per-lane spread (every forwarder quoting a lane, side by side, cheapest $/mile first).

  On load: read current rates + existing benchmarks; un-benchmarked rates → one batched route
  call → write-through into drayage_rate_benchmarks (§5, byproduct that seeds Layer 2). Re-runs
  are cheap: only new rates hit geo, and the brain caches lanes server-side.

  INTERNAL-ONLY (§1): these figures never reach a forwarder surface. This page is internal-route
  only and exports nothing.
*/

const dollars = (v) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const miDrive = (m, s) => {
  if (!(m > 0)) return '—'
  const mi = Math.round(m / 1609.344)
  const h = Math.floor(s / 3600)
  const min = Math.round((s % 3600) / 60)
  return `≈ ${mi.toLocaleString()} mi · ${h ? `${h}h ` : ''}${min}m drive`
}

/** Per-forwarder row within a lane. `pctOverMin` drives the "priciest" flag. */
function ForwarderRow({ row, best, min }) {
  const b = row.benchmark
  const cpm = b ? Number(b.cost_per_mile) : null
  const over = cpm != null && min ? (cpm - min) / min : 0
  const high = over > 0.15 && !best
  return (
    <div className={`grid grid-cols-[1.4fr_90px_92px_84px_88px] items-center gap-2 rounded-lg px-3 py-2 ${best ? 'bg-sea-50/60 ring-1 ring-inset ring-sea-100' : 'hover:bg-fog-50'}`}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Truck size={13} className={best ? 'text-sea-600' : 'text-fog-400'} />
        <span className="truncate text-sm font-medium text-harbor-900">{row.rate.forwarder?.name ?? '—'}</span>
        {best && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-sea-50 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-sea-700 ring-1 ring-inset ring-sea-200">
            <Award size={9} /> best
          </span>
        )}
      </span>
      <span className="text-right font-mono text-xs text-harbor-700">{dollars(row.rate.total_rate)}</span>
      <span className={`text-right font-mono text-sm font-bold ${high ? 'text-signal-700' : 'text-harbor-900'}`}>
        {cpm == null ? '—' : `$${cpm.toFixed(2)}`}
      </span>
      <span className="text-right font-mono text-[11px] text-fog-500">{b ? `$${Number(b.cost_per_hour).toFixed(0)}/hr` : '—'}</span>
      <span className="text-right font-mono text-[11px] text-fog-400">
        {best ? '—' : cpm != null && min ? `+${Math.round(over * 100)}%` : '—'}
      </span>
    </div>
  )
}

export default function DrayageAnalytics() {
  const navigate = useNavigate()
  const geoConfigured = Boolean(import.meta.env.VITE_GEO_API_URL)

  const [rates, setRates] = useState([])
  const [benchById, setBenchById] = useState(() => new Map())
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [error, setError] = useState(null)
  const [geoStats, setGeoStats] = useState(null)
  const [geoErrors, setGeoErrors] = useState([])
  const [toast, setToast] = useState(null)

  const showToast = (severity, message) => setToast({ severity, message })
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  /* ── load: current rates + existing benchmarks, then fill the gaps via geo ─────── */

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setGeoErrors([])
    const [{ rates, error: rErr }, { benchmarks, error: bErr }] = await Promise.all([
      fetchDrayageRates({ scope: 'current' }),
      fetchBenchmarks(),
    ])
    if (rErr || bErr) {
      setError((rErr || bErr).message)
      setLoading(false)
      return
    }
    const byId = new Map(benchmarks.map((b) => [b.rate_id, b]))
    setRates(rates)
    setBenchById(byId)
    setLoading(false)

    // rates missing a benchmark → route their unique lanes, compute, write through
    const missing = rates.filter((r) => !byId.has(r.id))
    if (missing.length === 0 || !geoConfigured) return

    setComputing(true)
    const lanes = dedupeLanes(missing)
    const { byLane, stats } = await routeLanes(lanes)
    setGeoStats(stats)

    // errors are per-lane; benchmarks are per-rate (every forwarder on a routed lane gets a row)
    setGeoErrors(lanes
      .filter((lane) => !byLane.get(lane.key)?.ok)
      .map((lane) => ({ lane: `${lane.a || '—'} → ${lane.b || '—'}`, error: byLane.get(lane.key)?.error ?? 'unknown' })))

    const fresh = []
    for (const r of missing) {
      const route = byLane.get(laneKey(r.last_cy_cfs, r.final_destination))
      if (route?.ok) {
        const row = benchmarkOf(r, route)
        if (row) fresh.push(row)
      }
    }

    if (fresh.length) {
      const { error: insErr } = await insertBenchmarks(fresh)
      if (insErr) showToast('warning', `Computed ${fresh.length} but couldn’t save: ${insErr.message}`)
      const next = new Map(byId)
      for (const row of fresh) next.set(row.rate_id, row)
      setBenchById(next)
    }
    setComputing(false)
  }, [geoConfigured])

  useEffect(() => { load() }, [load])

  /* ── derived ───────────────────────────────────────────────────────────── */

  const lanes = useMemo(() => groupByLane(rates, benchById), [rates, benchById])
  const multi = useMemo(() => lanes.filter((l) => l.rows.length > 1), [lanes])
  const single = useMemo(() => lanes.filter((l) => l.rows.length === 1), [lanes])
  const benchmarkedLanes = lanes.filter((l) => l.distance_m != null).length
  const coveredRates = useMemo(() => rates.filter((r) => benchById.has(r.id)).length, [rates, benchById])

  /* ── render ────────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Analytics"
        title="Drayage Analytics"
        subtitle="How competitive is each forwarder on the lanes they quote — $/mile and $/hour on the real truck route, side by side."
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/internal/analytics')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
            >
              <ArrowLeft size={15} /> Analytics
            </button>
            <button
              onClick={load}
              disabled={loading || computing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900 disabled:opacity-50"
            >
              <RefreshCw size={15} className={computing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        }
      />

      {!geoConfigured && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          VITE_GEO_API_URL is not configured — distance/time benchmarks can’t be computed.
        </div>
      )}

      {/* stats */}
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Lanes benchmarked" value={loading ? '—' : String(benchmarkedLanes)} icon={RouteIcon} accent="harbor" index={0} hint={`${lanes.length} lanes total`} />
        <StatCard label="Rates covered" value={loading ? '—' : `${coveredRates}/${rates.length}`} icon={Gauge} accent="sea" index={1} hint="current drayage rates" />
        <StatCard label="Multi-forwarder lanes" value={loading ? '—' : String(multi.length)} icon={TrendingUp} accent="signal" index={2} hint="where a spread exists" />
        <StatCard label="Geo errors" value={loading ? '—' : String(geoErrors.length)} icon={RefreshCw} accent="harbor" index={3} hint={geoStats ? `${geoStats.cacheHits} cached · ${geoStats.pairs} routed` : undefined} />
      </div>

      {computing && (
        <div className="flex items-center gap-2 rounded-xl border border-signal-200 bg-signal-50 px-4 py-2.5 text-xs text-signal-800">
          <Loader2 size={14} className="animate-spin" /> Benchmarking new lanes against the truck-route engine…
        </div>
      )}

      {geoErrors.length > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          <span className="font-semibold">Couldn’t route {geoErrors.length} lane{geoErrors.length === 1 ? '' : 's'}</span> (check location spelling):
          <ul className="mt-1 space-y-0.5">
            {geoErrors.map((e, i) => <li key={i} className="font-mono text-xs">{e.lane} — {e.error}</li>)}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load: {error}
        </div>
      ) : lanes.length === 0 ? (
        <div className="flex min-h-[36vh] flex-col items-center justify-center gap-2 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <TrendingUp size={26} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No drayage rates to benchmark yet</p>
          <p className="max-w-sm text-xs text-fog-500">Once current drayage rates exist, their $/mile and $/hour show up here.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* multi-forwarder lanes first — the spread is the point */}
          {multi.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400">Competitive lanes · {multi.length}</h2>
              <div className="stagger space-y-3">
                {multi.map((lane) => (
                  <LaneCard key={lane.key} lane={lane} />
                ))}
              </div>
            </section>
          )}

          {single.length > 0 && (
            <section className="space-y-3">
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-fog-400">Single-quote lanes · {single.length}</h2>
              <div className="space-y-3">
                {single.map((lane) => (
                  <LaneCard key={lane.key} lane={lane} single />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}

/* ── one lane's spread ─────────────────────────────────────────────────────── */

function LaneCard({ lane, single }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fog-100 bg-fog-50/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <RouteIcon size={14} className="text-harbor-500" />
          <span className="text-sm font-semibold text-harbor-900">{lane.label}</span>
          <span className="font-mono text-[11px] text-fog-500">{miDrive(lane.distance_m, lane.duration_s)}</span>
        </div>
        {!single && lane.min != null && lane.max != null && (
          <span className="font-mono text-[11px] text-fog-500">
            spread <span className="font-semibold text-harbor-700">${lane.min.toFixed(2)}</span>–<span className="font-semibold text-harbor-700">${lane.max.toFixed(2)}</span>/mi
            {lane.min > 0 && lane.max > lane.min && <span className="ml-1 text-signal-700">(+{Math.round(((lane.max - lane.min) / lane.min) * 100)}%)</span>}
          </span>
        )}
        {single && <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fog-400">only one forwarder — no spread</span>}
      </div>
      <div className="p-1.5">
        {/* column labels */}
        <div className="grid grid-cols-[1.4fr_90px_92px_84px_88px] gap-2 px-3 pb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.1em] text-fog-400">
          <span>Forwarder</span>
          <span className="text-right">Total</span>
          <span className="text-right">$/mile</span>
          <span className="text-right">$/hr</span>
          <span className="text-right">vs best</span>
        </div>
        {lane.rows.map((row, i) => (
          <ForwarderRow key={row.rate.id} row={row} best={i === 0 && lane.rows.length > 1 && row.benchmark != null} min={lane.min} />
        ))}
      </div>
    </div>
  )
}
