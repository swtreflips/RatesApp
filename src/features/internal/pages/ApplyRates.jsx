import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Upload, Play, Download, RotateCcw, Loader2, X, Route as RouteIcon } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import { fetchActiveRates } from '../services/applyRatesService'
import { buildApplyHeaderIndex, groupByOfq, deriveLanes } from '../applyRates/inputCsv'
import { dedupeRates, indexRatesByPol, matchLane } from '../applyRates/matcher'
import { createGeoBatch } from '../applyRates/geoBatch'
import { buildOutputRows, downloadCsv } from '../applyRates/outputCsv'

/*
  Internal "Apply Rates" — qualify active-rate yards against customer OFQ lanes.

  Upload the AIS OFQ export (ratesInput.csv shape) → matching runs immediately per
  unique (POL, Final Destination) lane: POL text match, then two-stage geo through
  the brain (ST_DWithin pre-filter → HERE truck route). The review matrix shows ALL
  qualifying yards per lane (CY A, CY B, … — closest first); the user discards yards
  (ⓧ per cell, per-row reset), then Create Rates downloads the AIS import CSV — every
  remaining yard's rates per OFQ, minus rates already applied to that OFQ (OFRID rows).
  Thresholds live in applyRates/config.js.
*/

// Non-qualified lanes are hidden from the matrix (no applicable rates = nothing to
// decide) and summarized in one line instead; these are their display labels.
const HIDDEN_STATUS_LABELS = {
  no_pol_match: 'no POL match',
  no_cy_in_range: 'no CY in range',
  no_last_cy: 'no Last CY on rates',
  no_destination: 'no destination',
}

/* A qualified-yard cell: input-box look (à la NetSuite) with an ⓧ to discard it from
   the lane. A discarded yard stays in place, dimmed — column positions and the
   closest-first ordering stay legible; restore is the row's reset icon. */
function YardCell({ yard, discarded, onDiscard }) {
  return (
    <div
      className={`inline-flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-2.5 py-1.5 text-xs shadow-sm ${
        discarded ? 'border-dashed border-fog-300 opacity-40' : 'border-fog-300'
      }`}
    >
      <span className={`truncate text-harbor-900 ${discarded ? 'line-through' : ''}`}>
        {yard.cyLabel} · {Math.round(yard.miles)} mi · {yard.rates.length} rate{yard.rates.length === 1 ? '' : 's'}
      </span>
      {!discarded && (
        <button
          className="shrink-0 rounded-full p-0.5 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
          onClick={onDiscard}
          tabIndex={-1}
          title="Discard this yard for this lane"
        >
          <X size={13} />
        </button>
      )}
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
  const [progress, setProgress] = useState({ done: 0, total: 0, current: null })
  const [results, setResults] = useState([]) // matchLane results, one per lane
  const [discarded, setDiscarded] = useState(() => new Map()) // laneKey → Set<cyNorm>
  const [geoStats, setGeoStats] = useState(null)
  const [toast, setToast] = useState(null)
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
    setProgress({ done: 0, total: lanes.length, current: null })

    const ratesByPol = indexRatesByPol(dedupeRates(activeRates))
    const geo = createGeoBatch()
    const out = []

    for (let i = 0; i < lanes.length; i += 1) {
      if (cancelRef.current) return // unmounted mid-run — drop everything
      setProgress({ done: i, total: lanes.length, current: `${lanes[i].pol} → ${lanes[i].fd}` })
      // eslint-disable-next-line no-await-in-loop -- sequential per lane by design (quota safety)
      out.push(await matchLane(lanes[i], ratesByPol, geo))
    }

    setResults(out)
    setGeoStats({ ...geo.stats })
    setProgress({ done: lanes.length, total: lanes.length, current: null })
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

  /* ── yard discard / restore (state lives OUTSIDE the grid rows) ──────── */

  const discardYard = (laneKey, cyNorm) => setDiscarded((prev) => {
    const next = new Map(prev)
    const set = new Set(next.get(laneKey) ?? [])
    set.add(cyNorm)
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
    setPhase('idle')
  }

  /* ── qualification matrix (qualified lanes only) ─────────────────────── */

  const qualifiedRows = useMemo(() => results.filter((r) => r.status === 'matched'), [results])

  const matrixColumns = useMemo(() => {
    const maxQualified = qualifiedRows.reduce((m, r) => Math.max(m, r.qualified.length), 0)

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
            title="Restore this lane's discarded yards"
          >
            <RotateCcw size={14} />
          </button>
        ) : null),
      },
    ]

    for (let i = 0; i < maxQualified; i += 1) {
      cols.push({
        field: `cy${i}`,
        headerName: `CY ${String.fromCharCode(65 + i)}`,
        width: 235,
        sortable: false,
        filterable: false,
        renderCell: (p) => {
          const yard = p.row.qualified[i]
          if (!yard) return null
          return (
            <div className="flex h-full w-full items-center">
              <YardCell
                yard={yard}
                discarded={discarded.get(p.row.laneKey)?.has(yard.cyNorm) ?? false}
                onDiscard={() => discardYard(p.row.laneKey, yard.cyNorm)}
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
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0

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
        subtitle="Upload the OFQ export — every qualifying yard per lane is shown closest-first; discard the ones you don't want, then create the AIS import file."
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

        <div className="flex-1" />

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
            hint={geoStats ? `${geoStats.calls} geo calls · ${geoStats.memoHits} reused in-job` : undefined}
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
            Matching runs immediately: each lane shows every qualifying yard, closest first.
          </div>
        </button>
      )}

      {phase === 'running' && (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
          <div className="w-72">
            <div className="h-2 overflow-hidden rounded-full bg-fog-100">
              <div className="h-2 rounded-full bg-signal-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="font-mono text-xs text-fog-400">
            {progress.done} / {progress.total} lanes{progress.current ? ` · ${progress.current}` : ''}
          </div>
        </div>
      )}

      {phase === 'review' && (qualifiedRows.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
          <DataGrid
            rows={qualifiedRows}
            getRowId={(r) => r.laneKey}
            columns={matrixColumns}
            rowHeight={64}
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(qualifiedRows.length, { rowH: 64 }) }}
          />
        </div>
      ) : (
        <div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <RouteIcon size={26} className="text-fog-300" />
          <div className="text-sm text-fog-500">
            No lanes qualified — none of the active rates’ yards are within range of these destinations.
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
