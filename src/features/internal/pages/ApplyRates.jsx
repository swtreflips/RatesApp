import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Upload, Play, Download, RotateCcw, Loader2, X, Route as RouteIcon } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import { fetchActiveRates } from '../services/applyRatesService'
import { buildApplyHeaderIndex, groupByOfq, deriveLanes } from '../applyRates/inputCsv'
import {
  dedupeRates, indexRatesByPol, matchLanesBatch, filterByRunway, DEFAULT_MIN_VALID_DAYS,
} from '../applyRates/matcher'
import { createBatchGeo } from '../applyRates/geoBatch'
import { buildOutputRows, downloadCsv } from '../applyRates/outputCsv'

/*
  Internal "Apply Rates" — qualify active-rate yards against customer OFQ lanes.

  Upload the AIS OFQ export (ratesInput.csv shape) → matching runs immediately per
  unique (POL, Final Destination) lane: POL text match, then two-stage geo through
  the brain (ST_DWithin pre-filter → HERE truck route). The review matrix shows ALL
  qualifying ROUTES per lane (Route A, Route B, … — closest first), a route being the
  (Port of Discharge, Last CY) pair the rates actually run on — so rates sharing a yard
  but discharging at different ports stay distinct and separately discardable. The user
  discards routes (ⓧ per cell, per-row reset), then Create Rates downloads the AIS import
  CSV — every remaining route's rates per OFQ, minus rates already applied to that OFQ
  (OFRID rows). Qualification itself is per Last CY (see matcher.js); thresholds live in
  applyRates/config.js.
*/

// Non-qualified lanes are hidden from the matrix (no applicable rates = nothing to
// decide) and summarized in one line instead; these are their display labels.
const HIDDEN_STATUS_LABELS = {
  no_pol_match: 'no POL match',
  // Rates exist out of this port, just not for this box size — a different problem with a
  // different fix (ask the forwarders already quoting the lane for this size).
  no_container_match: 'no rate for this box size',
  no_cy_in_range: 'no CY in range',
  no_last_cy: 'no Last CY on rates',
  no_destination: 'no destination',
}

/* A qualified-route cell: input-box look (à la NetSuite) with an ⓧ to discard it from the
   lane. Reads as the routing being applied — "Port of Discharge → Last CY" — so rates that
   merely share a yard but discharge at different ports are never mistaken for one another;
   drayage miles (CY → Final Destination) and the rate count sit beneath. Full routing is in
   the title attr, since a long chain truncates. A discarded route stays in place, dimmed —
   column positions and the closest-first ordering stay legible; restore is the row's reset
   icon. */
function RouteCell({ route, discarded, onDiscard }) {
  return (
    <div
      className={`flex w-full flex-col gap-0.5 rounded-lg border bg-white px-2.5 py-1.5 text-xs shadow-sm ${
        discarded ? 'border-dashed border-fog-300 opacity-40 line-through' : 'border-fog-300'
      }`}
    >
      <div className="flex items-center justify-between gap-1.5">
        {/* the routing being applied: Port of Discharge → Last CY */}
        <span className="truncate text-harbor-900" title={`${route.podLabel || '—'} → ${route.cyLabel}`}>
          {route.podLabel || '—'}
          <span className="mx-1 text-fog-400">→</span>
          {route.cyLabel}
        </span>
        {!discarded && (
          <button
            className="-mr-0.5 shrink-0 rounded-full p-0.5 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
            onClick={onDiscard}
            tabIndex={-1}
            title="Discard this route for this lane"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="font-mono text-[10px] text-fog-500">
        {Math.round(route.miles)} mi · {route.rates.length} rate{route.rates.length === 1 ? '' : 's'}
      </div>
    </div>
  )
}

export default function ApplyRates() {
  const [phase, setPhase] = useState('idle') // idle | running | review
  const [ofqs, setOfqs] = useState([])
  const [fileName, setFileName] = useState(null)
  const [activeRates, setActiveRates] = useState([])
  const [ratesLoading, setRatesLoading] = useState(true)
  const [ratesError, setRatesError] = useState(null)
  const [progress, setProgress] = useState({ pct: 0, label: '' })
  const [results, setResults] = useState([]) // matchLane results, one per lane
  const [discarded, setDiscarded] = useState(() => new Map()) // laneKey → Set<routeKey>
  const [geoStats, setGeoStats] = useState(null)
  const [toast, setToast] = useState(null)
  // Minimum days of validity a rate must have left to be worth applying. See matcher.js — this
  // is "worth applying", which is a different question from "still valid".
  const [minValidDays, setMinValidDays] = useState(DEFAULT_MIN_VALID_DAYS)
  // What the results on screen were actually matched with. Results computed at 4 days must not
  // sit under a control reading 7 as though they agreed.
  const [ranWithMinDays, setRanWithMinDays] = useState(null)
  const fileInputRef = useRef(null)
  const cancelRef = useRef(false)

  const geoConfigured = Boolean(import.meta.env.VITE_GEO_API_URL)

  /* ── load the active rate pool ───────────────────────────────────────── */

  const loadRates = useCallback(async () => {
    setRatesLoading(true)
    setRatesError(null)
    const { rates, error } = await fetchActiveRates()
    if (error) setRatesError(error.message)
    else setActiveRates(rates)
    setRatesLoading(false)
  }, [])

  useEffect(() => { loadRates() }, [loadRates])

  // Filtered here rather than in the query: the pool is already loaded, so changing the threshold
  // is instant and costs no round trip. The count it produces is the control's own feedback.
  const eligibleRates = useMemo(
    () => filterByRunway(activeRates, minValidDays),
    [activeRates, minValidDays],
  )

  // stop an in-flight run if the page unmounts
  useEffect(() => () => { cancelRef.current = true }, [])

  /* ── toast ───────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message) => setToast({ severity, message })

  /* ── matching (auto-runs right after a successful parse) ─────────────── */

  const runMatching = async (lanes) => {
    cancelRef.current = false
    setPhase('running')
    setProgress({ pct: 0, label: 'Preparing…' })

    const ratesByPol = indexRatesByPol(dedupeRates(eligibleRates))
    // The whole job is two batch POSTs — progress moves per phase, not per lane.
    const geo = createBatchGeo({
      onPhase: (kind, pairCount) => setProgress(kind === 'within'
        ? { pct: 10, label: `Checking proximity… (${pairCount} pairs)` }
        : { pct: 55, label: `Calculating drayage routes… (${pairCount} pairs)` }),
    })

    const out = await matchLanesBatch(lanes, ratesByPol, geo)
    if (cancelRef.current) return // unmounted mid-run — drop everything

    setResults(out)
    setGeoStats({ ...geo.stats })
    setProgress({ pct: 100, label: '' })
    setRanWithMinDays(minValidDays)
    setPhase('review')
  }

  /* ── upload + parse (browse or drag-and-drop) ────────────────────────── */

  const ACCEPTED_EXTS = ['csv', 'xlsx', 'xls']

  const handleFile = (file) => {
    if (!file) return
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    if (!ACCEPTED_EXTS.includes(ext)) {
      return showToast('warning', `Unsupported file type ".${ext}" — expected .csv, .xlsx or .xls`)
    }

    parseRateFile(file, {
      complete(res) {
        const [headerCells, ...dataRows] = res.data
        if (!headerCells) return showToast('warning', 'File had no rows.')
        const { index, missing } = buildApplyHeaderIndex(headerCells)
        if (missing.length) return showToast('error', `Missing column(s): ${missing.join(', ')}`)
        const { ofqs: parsed, warnings } = groupByOfq(dataRows, index)
        if (!parsed.length) return showToast('warning', 'No OFQ rows found in the file.')

        // matching starts immediately, so its preconditions gate the upload itself
        if (!geoConfigured) return showToast('error', 'VITE_GEO_API_URL is not set — geo checks unavailable.')
        if (ratesLoading || ratesError) {
          return showToast('warning', 'Active rates are still loading — drop the file again in a moment.')
        }

        setOfqs(parsed)
        setFileName(file.name)
        setResults([])
        setDiscarded(new Map())
        setGeoStats(null)
        if (warnings.length) showToast('warning', warnings[0])
        runMatching(deriveLanes(parsed))
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })
  }

  const handleFileUpload = (e) => {
    handleFile(e.target.files?.[0])
    e.target.value = ''
  }

  /* ── drag-and-drop (whole page is a drop target, except mid-run) ─────── */

  const [dragOver, setDragOver] = useState(false)
  // dragenter/dragleave fire on every child crossing — a counter avoids flicker
  const dragDepthRef = useRef(0)

  const canDrop = phase !== 'running'

  const handleDragEnter = (e) => {
    e.preventDefault()
    dragDepthRef.current += 1
    if (canDrop) setDragOver(true)
  }
  const handleDragOver = (e) => {
    e.preventDefault() // required, or the browser opens the file itself
  }
  const handleDragLeave = (e) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  const handleDrop = (e) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    if (!canDrop) return
    handleFile(e.dataTransfer?.files?.[0])
  }

  /* ── route discard / restore (state lives OUTSIDE the grid rows) ─────── */

  const discardRoute = (laneKey, routeKey) => setDiscarded((prev) => {
    const next = new Map(prev)
    const set = new Set(next.get(laneKey) ?? [])
    set.add(routeKey)
    next.set(laneKey, set)
    return next
  })

  const resetLane = (laneKey) => setDiscarded((prev) => {
    if (!prev.has(laneKey)) return prev
    const next = new Map(prev)
    next.delete(laneKey)
    return next
  })

  /* ── output (live: reflects discards instantly) ──────────────────────── */

  const outputRows = useMemo(
    () => (phase === 'review' ? buildOutputRows(ofqs, results, discarded) : []),
    [phase, ofqs, results, discarded],
  )

  const handleDownload = () => {
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(outputRows, `applied-rates-${date}.csv`)
  }

  const handleReset = () => {
    setOfqs([])
    setFileName(null)
    setResults([])
    setDiscarded(new Map())
    setGeoStats(null)
    // The threshold itself survives — it is a preference, not part of the run. What it produced
    // does not, or a fresh upload would inherit a stale "showing N" from the previous file.
    setRanWithMinDays(null)
    setPhase('idle')
  }

  /* ── qualification matrix (qualified lanes only) ─────────────────────── */

  const qualifiedRows = useMemo(() => results.filter((r) => r.status === 'matched'), [results])

  const matrixColumns = useMemo(() => {
    const maxRoutes = qualifiedRows.reduce((m, r) => Math.max(m, r.qualified.length), 0)

    const cols = [
      { field: 'pol', headerName: 'Port of Loading', flex: 1, minWidth: 130 },
      { field: 'fd', headerName: 'Final Destination', flex: 1, minWidth: 130 },
      {
        field: 'ofqIds', headerName: 'OFQs', width: 64, sortable: false, cellClassName: 'font-mono',
        valueGetter: (v) => v?.length ?? 0,
      },
      {
        field: 'reset', headerName: '', width: 48, sortable: false, filterable: false,
        renderCell: (p) => ((discarded.get(p.row.laneKey)?.size ?? 0) > 0 ? (
          <button
            className="rounded-md p-1 text-fog-400 transition-colors hover:bg-harbor-50 hover:text-harbor-700"
            onClick={() => resetLane(p.row.laneKey)}
            tabIndex={-1}
            title="Restore this lane's discarded routes"
          >
            <RotateCcw size={14} />
          </button>
        ) : null),
      },
    ]

    for (let i = 0; i < maxRoutes; i += 1) {
      cols.push({
        field: `route${i}`,
        headerName: `Route ${String.fromCharCode(65 + i)}`,
        width: 280,
        sortable: false,
        filterable: false,
        renderCell: (p) => {
          const route = p.row.qualified[i]
          if (!route) return null
          return (
            <div className="flex h-full w-full items-center">
              <RouteCell
                route={route}
                discarded={discarded.get(p.row.laneKey)?.has(route.routeKey) ?? false}
                onDiscard={() => discardRoute(p.row.laneKey, route.routeKey)}
              />
            </div>
          )
        },
      })
    }

    cols.push({
      field: 'errors', headerName: 'Notes', flex: 1.2, minWidth: 130, sortable: false,
      valueGetter: (v) => (v?.length ? v.join(' · ') : ''),
    })

    return cols
  }, [qualifiedRows, discarded])

  /* ── derived summary ─────────────────────────────────────────────────── */

  const geoErrorLanes = results.filter((r) => r.status === 'geo_error')
  // hidden = nothing to decide on: no applicable rates in the system for the lane
  const hiddenCounts = results.reduce((acc, r) => {
    if (HIDDEN_STATUS_LABELS[r.status]) acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})
  const hiddenTotal = Object.values(hiddenCounts).reduce((a, b) => a + b, 0)

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div
      className="relative space-y-6"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* drop cue — covers the page while a file is dragged over it */}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-signal-400 bg-signal-50/80">
          <div className="flex items-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-harbor-900 shadow-card-hover">
            <Upload size={18} className="text-signal-600" />
            Drop the OFQ file to {phase === 'idle' ? 'upload' : 'replace the current file'}
          </div>
        </div>
      )}

      <PageHeader
        kicker="Internal · Rates"
        title="Apply Rates"
        actions={fileName && (
          <span className="inline-flex items-center gap-2 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
            <span className="font-mono text-xs text-harbor-900">{fileName}</span>
          </span>
        )}
      />

      {!geoConfigured && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          VITE_GEO_API_URL is not configured — distance checks can’t run.
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => fileInputRef.current?.click()}
          disabled={phase === 'running'}
        >
          <Upload size={16} />
          {phase === 'idle' ? 'Upload OFQ File' : 'Upload Different File'}
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleFileUpload} />

        {/* Minimum runway. The live count beside it is the point of the control — you can see what
            a threshold costs you before spending a match on it. */}
        <label className="inline-flex items-center gap-2 rounded-lg border border-fog-300 bg-white px-3 py-2 shadow-sm">
          <span className="text-sm text-harbor-700">Valid at least</span>
          <input
            type="number"
            min="0"
            max="365"
            value={minValidDays}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10)
              setMinValidDays(Number.isFinite(n) && n >= 0 ? n : 0)
            }}
            disabled={phase === 'running'}
            className="w-12 rounded border border-fog-200 bg-fog-50 px-1.5 py-0.5 text-center font-mono text-sm text-harbor-900 outline-none transition-colors focus:border-harbor-400 disabled:opacity-50"
          />
          <span className="text-sm text-harbor-700">days</span>
          {!ratesLoading && !ratesError && (
            <span className="font-mono text-[11px] text-fog-500">
              · {eligibleRates.length} of {activeRates.length} rates
            </span>
          )}
        </label>

        <div className="flex-1" />

        {/* Changing the threshold after a run does NOT silently re-match: the match spends two
            batch geo calls, and quietly burning quota because someone nudged a stepper is not a
            decision the app should take. It also must not leave results computed at 4 days sitting
            under a control that reads 7 — so the mismatch is stated, with the way to resolve it. */}
        {phase === 'review' && ranWithMinDays !== null && ranWithMinDays !== minValidDays && (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-signal-300 bg-signal-50 px-3 py-2 text-sm font-medium text-signal-900 shadow-sm transition-all hover:bg-signal-100"
            onClick={() => runMatching(deriveLanes(ofqs))}
          >
            <RotateCcw size={15} />
            Re-match at {minValidDays} days
            <span className="font-mono text-[11px] text-signal-700">(showing {ranWithMinDays})</span>
          </button>
        )}

        {phase === 'review' && (
          <>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
              onClick={handleReset}
            >
              <RotateCcw size={15} />
              Start Over
            </button>
            <button
              className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
              onClick={handleDownload}
              disabled={outputRows.length === 0}
            >
              <Download size={16} className="transition-transform group-hover:translate-y-0.5" />
              Create Rates ({outputRows.length})
            </button>
          </>
        )}
      </div>

      {/* Stat cards */}
      {phase === 'review' && (
        <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Qualified lanes" value={String(qualifiedRows.length)} icon={RouteIcon} accent="harbor" index={0} hint={`of ${results.length} lanes in the file`} />
          <StatCard label="OFQs" value={String(ofqs.length)} icon={Upload} accent="sea" index={1} />
          <StatCard label="Rates to apply" value={String(outputRows.length)} icon={Download} accent="signal" index={2} hint="Live — updates as you discard yards" />
          <StatCard
            label="Geo errors"
            value={String(geoErrorLanes.length)}
            icon={Play}
            accent="harbor"
            index={3}
            hint={geoStats ? `${geoStats.withinPairs} proximity + ${geoStats.routePairs} route pairs · ${geoStats.cacheHits} cached` : undefined}
          />
        </div>
      )}

      {/* Geo-error lanes: not "no rates" — often a typo worth fixing, so list them */}
      {phase === 'review' && geoErrorLanes.length > 0 && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-card">
          <span className="font-semibold">Couldn’t evaluate {geoErrorLanes.length} lane{geoErrorLanes.length === 1 ? '' : 's'}</span>
          {' '}(check location spelling):
          <ul className="mt-1 space-y-0.5">
            {geoErrorLanes.map((l) => (
              <li key={l.laneKey} className="font-mono text-xs">
                {l.pol} → {l.fd} — {l.errors.join(' · ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Body */}
      {phase === 'idle' && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex min-h-[40vh] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-fog-300 bg-white text-center shadow-card transition-colors hover:border-signal-400 hover:bg-signal-50/40"
        >
          <Upload size={28} className="text-fog-300" />
          <div className="text-sm text-fog-500">
            Drag & drop the OFQ export (.csv or .xlsx) here — or click to browse.
            <br />
            Matching runs immediately: each lane shows every qualifying route, closest first.
          </div>
        </button>
      )}

      {phase === 'running' && (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
          <div className="w-72">
            <div className="h-2 overflow-hidden rounded-full bg-fog-100">
              <div className="h-2 rounded-full bg-signal-500 transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
          <div className="font-mono text-xs text-fog-400">{progress.label}</div>
        </div>
      )}

      {phase === 'review' && (qualifiedRows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
          <DataGrid
            rows={qualifiedRows}
            getRowId={(r) => r.laneKey}
            columns={matrixColumns}
            rowHeight={70}
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(qualifiedRows.length, { rowH: 70 }) }}
          />
        </div>
      ) : (
        <div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <RouteIcon size={26} className="text-fog-300" />
          <div className="text-sm text-fog-500">
            No lanes qualified — none of the active rates’ Last CY yards are within range of these destinations.
          </div>
        </div>
      ))}

      {/* Hidden-lane summary: lanes with no applicable rates in the system */}
      {phase === 'review' && hiddenTotal > 0 && (
        <div className="text-xs text-fog-400">
          {hiddenTotal} lane{hiddenTotal === 1 ? '' : 's'} without applicable rates hidden — {' '}
          {Object.entries(hiddenCounts).map(([status, count]) => `${count} ${HIDDEN_STATUS_LABELS[status]}`).join(' · ')}
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
