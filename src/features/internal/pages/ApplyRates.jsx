import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Upload, Play, Download, RotateCcw, Loader2, Route as RouteIcon } from 'lucide-react'
import { PageHeader, StatCard } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import { fetchActiveRates } from '../services/applyRatesService'
import { buildApplyHeaderIndex, groupByOfq } from '../applyRates/inputCsv'
import { dedupeRates, indexRatesByPol, matchOfq } from '../applyRates/matcher'
import { createGeoBatch } from '../applyRates/geoBatch'
import { buildOutputRows, downloadCsv } from '../applyRates/outputCsv'

/*
  Internal "Apply Rates" — match active rates to customer OFQs by drayage distance.

  Upload the AIS OFQ export (ratesInput.csv shape) → the app matches each OFQ against
  the active rate pool: POL text match, then two-stage geo qualification through the
  geo brain (straight-line ST_DWithin pre-filter → real HERE truck route), picks the
  closest qualifying Last CY, skips rates already applied (OFRID rows), and produces
  the AIS import CSV (ratesTemplate.csv shape). Thresholds live in applyRates/config.js.
*/

const STATUS_META = {
  matched:             { label: 'Matched',         cls: 'bg-sea-50 text-sea-700 border-sea-200' },
  all_already_applied: { label: 'Already applied', cls: 'bg-fog-100 text-fog-500 border-fog-200' },
  no_pol_match:        { label: 'No POL match',    cls: 'bg-signal-50 text-signal-700 border-signal-200' },
  no_cy_in_range:      { label: 'No CY in range',  cls: 'bg-signal-50 text-signal-700 border-signal-200' },
  no_last_cy:          { label: 'No Last CY',      cls: 'bg-signal-50 text-signal-700 border-signal-200' },
  no_destination:      { label: 'No destination',  cls: 'bg-signal-50 text-signal-700 border-signal-200' },
  geo_error:           { label: 'Geo error',       cls: 'bg-red-50 text-red-700 border-red-200' },
}

function StatusChip({ status }) {
  const meta = STATUS_META[status] ?? { label: status, cls: 'bg-fog-100 text-fog-500 border-fog-200' }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

export default function ApplyRates() {
  const [phase, setPhase] = useState('idle') // idle | parsed | running | done
  const [ofqs, setOfqs] = useState([])
  const [fileName, setFileName] = useState(null)
  const [activeRates, setActiveRates] = useState([])
  const [ratesLoading, setRatesLoading] = useState(true)
  const [ratesError, setRatesError] = useState(null)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: null })
  const [results, setResults] = useState([])
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
        setOfqs(parsed)
        setFileName(file.name)
        setResults([])
        setGeoStats(null)
        setPhase('parsed')
        if (warnings.length) showToast('warning', warnings[0])
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

  /* ── run matching ────────────────────────────────────────────────────── */

  const handleRun = async () => {
    if (!geoConfigured) return showToast('error', 'VITE_GEO_API_URL is not set — geo checks unavailable.')
    if (ratesLoading || ratesError) return showToast('warning', 'Active rates are not loaded yet.')

    cancelRef.current = false
    setPhase('running')
    setProgress({ done: 0, total: ofqs.length, current: null })

    const ratesByPol = indexRatesByPol(dedupeRates(activeRates))
    const geo = createGeoBatch()
    const out = []

    for (let i = 0; i < ofqs.length; i += 1) {
      if (cancelRef.current) return // unmounted mid-run — drop everything
      setProgress({ done: i, total: ofqs.length, current: ofqs[i].ofqId })
      // eslint-disable-next-line no-await-in-loop -- sequential per OFQ by design (quota safety)
      out.push(await matchOfq(ofqs[i], ratesByPol, geo))
    }

    setResults(out)
    setGeoStats({ ...geo.stats })
    setProgress({ done: ofqs.length, total: ofqs.length, current: null })
    setPhase('done')
  }

  /* ── download ────────────────────────────────────────────────────────── */

  const outputRows = buildOutputRows(results)

  const handleDownload = () => {
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(outputRows, `applied-rates-${date}.csv`)
  }

  const handleReset = () => {
    setOfqs([])
    setFileName(null)
    setResults([])
    setGeoStats(null)
    setPhase('idle')
  }

  /* ── grid columns ────────────────────────────────────────────────────── */

  const previewColumns = [
    { field: 'ofqId', headerName: 'OFQ', width: 110, cellClassName: 'font-mono' },
    { field: 'pol', headerName: 'Port of Loading', flex: 1.1, minWidth: 140 },
    { field: 'fd', headerName: 'Final Destination', flex: 1.1, minWidth: 140 },
    { field: 'rowCount', headerName: 'Rows', width: 70, type: 'number', cellClassName: 'font-mono' },
    { field: 'appliedCount', headerName: 'Already applied', width: 120, type: 'number', cellClassName: 'font-mono' },
  ]

  const resultColumns = [
    { field: 'ofqId', headerName: 'OFQ', width: 110, cellClassName: 'font-mono' },
    {
      field: 'status', headerName: 'Status', width: 140, sortable: false,
      renderCell: (p) => <StatusChip status={p.value} />,
    },
    { field: 'pol', headerName: 'Port of Loading', flex: 1, minWidth: 130 },
    { field: 'fd', headerName: 'Final Destination', flex: 1, minWidth: 130 },
    { field: 'bestCy', headerName: 'Closest CY', flex: 0.9, minWidth: 110, valueGetter: (v) => v ?? '—' },
    {
      field: 'routeMiles', headerName: 'Drayage mi', width: 96, type: 'number', cellClassName: 'font-mono',
      valueFormatter: (v) => (v == null ? '—' : v.toFixed(1)),
    },
    {
      field: 'applied', headerName: 'Rates to apply', width: 110, type: 'number', cellClassName: 'font-mono',
      valueGetter: (v) => v?.length ?? 0,
    },
    {
      field: 'errors', headerName: 'Notes', flex: 1.2, minWidth: 140, sortable: false,
      valueGetter: (v) => (v?.length ? v.join(' · ') : ''),
    },
  ]

  /* ── derived summary ─────────────────────────────────────────────────── */

  const matchedCount = results.filter((r) => r.status === 'matched').length
  const noMatchCount = results.filter((r) => ['no_pol_match', 'no_cy_in_range', 'no_last_cy', 'no_destination'].includes(r.status)).length
  const errorCount = results.filter((r) => r.status === 'geo_error').length
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
        subtitle="Upload the OFQ export — active rates are matched to each quote by POL and drayage distance from the Last CY, and the result downloads as the AIS import file."
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

        {phase === 'parsed' && (
          <button
            className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
            onClick={handleRun}
            disabled={!geoConfigured || ratesLoading || Boolean(ratesError)}
          >
            <Play size={16} className="transition-transform group-hover:scale-110" />
            Run Matching
          </button>
        )}
        {phase === 'done' && (
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
              Download CSV ({outputRows.length})
            </button>
          </>
        )}
      </div>

      {/* Stat cards */}
      {phase === 'parsed' && (
        <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="OFQs found" value={String(ofqs.length)} icon={RouteIcon} accent="harbor" index={0} />
          <StatCard label="Input rows" value={String(ofqs.reduce((n, o) => n + o.rowCount, 0))} icon={Upload} accent="sea" index={1} />
          <StatCard label="Already applied" value={String(ofqs.reduce((n, o) => n + o.appliedCount, 0))} icon={Download} accent="signal" index={2} />
          <StatCard
            label="Active rates"
            value={ratesLoading ? '…' : String(activeRates.length)}
            icon={Play}
            accent="sea"
            index={3}
            hint={ratesError ? `Load failed: ${ratesError}` : 'Pool the OFQs are matched against'}
          />
        </div>
      )}
      {phase === 'done' && (
        <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard label="Matched OFQs" value={String(matchedCount)} icon={RouteIcon} accent="sea" index={0} />
          <StatCard label="Rates to apply" value={String(outputRows.length)} icon={Download} accent="signal" index={1} />
          <StatCard label="No match" value={String(noMatchCount)} icon={Upload} accent="harbor" index={2} />
          <StatCard
            label="Geo errors"
            value={String(errorCount)}
            icon={Play}
            accent="harbor"
            index={3}
            hint={geoStats ? `${geoStats.calls} geo calls · ${geoStats.memoHits} reused in-job` : undefined}
          />
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
            Expected columns: OFQID, Port of Loading, Final Destination — plus the applied-rate columns (OFRID…).
          </div>
        </button>
      )}

      {phase === 'parsed' && (
        <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
          <DataGrid
            rows={ofqs}
            getRowId={(r) => r.ofqId}
            columns={previewColumns}
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(ofqs.length) }}
          />
        </div>
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
            {progress.done} / {progress.total} OFQs{progress.current ? ` · ${progress.current}` : ''}
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
          <DataGrid
            rows={results}
            getRowId={(r) => r.ofqId}
            columns={resultColumns}
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(results.length) }}
          />
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
