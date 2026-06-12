import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Plus, Upload, Send, X, Loader2 } from 'lucide-react'
import Papa from 'papaparse'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { fetchActiveLanes, submitRates, skipLane, unskipLane } from '../services/submissionService'

/*
  Provider rate-entry grid — unified (request-driven + free entry).

  - When the requester has ACTIVE lanes, they preload as read-only guide rows
    (template columns: POL · FD · Container Type · # Containers; FD/type/count are
    request-side guides only, not part of a rate).
  - The forwarder can ALSO add free rows or upload a CSV to submit rates that exist
    independently of any request (PROVIDER_VIEW_MODEL §4). Independent rows carry no
    laneId → submissionService writes them with null lane_id/submission_id/period.

  A rate = POL · POD · Last CY · Rate/Unit · Free Days · Carrier · Valid Until · Remarks.
  No fields are required yet.
*/

// temp id for free rows — string-prefixed so it never collides with a lane's uuid id
let nextTempId = 1

const makeEmptyRow = () => ({
  id: `new-${nextTempId++}`,
  laneId: null,
  period: null,
  // template/guide (blank for free rows)
  fd: '',
  containerType: '',
  containerCount: '',
  // rate fields
  pol: '',
  pod: '',
  lastCy: '',
  rate: '',
  freeDays: '',
  carrier: '',
  validUntil: null,
  remarks: '',
})

const makeRowFromLane = (lane) => ({
  id: lane.id,            // grid id = lane id (stable, unique)
  laneId: lane.id,
  period: lane.period,
  // from the request template (read-only guides)
  fd: lane.fd ?? '',
  containerType: lane.container_type ?? '',
  containerCount: lane.container_count ?? '',
  // rate fields the forwarder fills in (POL prefilled from the template)
  pol: lane.pol ?? '',
  pod: '',
  lastCy: '',
  rate: '',
  freeDays: '',
  carrier: '',
  validUntil: null,
  remarks: '',
})

const firstNonEmpty = (row, keys) => {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim()
  }
  return ''
}

const makeRowFromCsv = (row) => {
  const validRaw = firstNonEmpty(row, ['valid_until', 'Valid Until', 'validUntil', 'valid until'])
  const valid = validRaw ? new Date(validRaw) : null
  return {
    id: `new-${nextTempId++}`,
    laneId: null,
    period: null,
    fd: '',
    containerType: '',
    containerCount: '',
    pol: firstNonEmpty(row, ['pol', 'POL', 'Port of Loading', 'port_of_loading']),
    pod: firstNonEmpty(row, ['pod', 'POD', 'Port of Discharge', 'port_of_discharge']),
    lastCy: firstNonEmpty(row, ['last_cy', 'Last CY', 'lastcy', 'lastCy']),
    rate: firstNonEmpty(row, ['rate', 'Rate', 'Rate/Unit', 'Rate per Unit', 'rate_amount']),
    freeDays: firstNonEmpty(row, ['free_days', 'Free Days', '# of Free Days', 'freeDays']),
    carrier: firstNonEmpty(row, ['carrier', 'Carrier']),
    validUntil: valid && !isNaN(valid.getTime()) ? valid : null,
    remarks: firstNonEmpty(row, ['remarks', 'Remarks', 'notes', 'Notes']),
  }
}

const isBlankRow = (r) =>
  !r.laneId && !r.pol && r.rate === '' && !r.pod && !r.lastCy && !r.carrier && !r.remarks

const TOAST_COLORS = {
  success: 'bg-sea-600',
  warning: 'bg-signal-600',
  error:   'bg-red-600',
}

export default function SubmitRates() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)

  /* ── load active lanes (seed an empty free row when there are none) ───── */

  const loadLanes = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const { lanes, error } = await fetchActiveLanes()
    if (error) setLoadError(error.message)
    else setRows(lanes.length ? lanes.map(makeRowFromLane) : [makeEmptyRow()])
    setLoading(false)
  }, [])

  useEffect(() => { loadLanes() }, [loadLanes])

  /* ── auto-dismiss toast ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message, action = null) => setToast({ severity, message, action })

  /* ── columns ─────────────────────────────────────────────────────────── */

  const columns = [
    {
      field: 'rowNum',
      headerName: '#',
      width: 38,
      sortable: false,
      filterable: false,
      cellClassName: 'font-mono text-fog-400',
      renderCell: (params) => params.api.getRowIndexRelativeToVisibleRows(params.row.id) + 1,
    },
    { field: 'pol',    headerName: 'Port of Loading',   flex: 1.1, minWidth: 86, editable: true },
    // template guides (request-side only; blank for free rows)
    { field: 'fd',     headerName: 'Final Destination', flex: 1.1, minWidth: 86 },
    { field: 'containerType', headerName: 'Cont. Type', width: 88, cellClassName: 'font-mono' },
    { field: 'containerCount', headerName: '# Cont.', width: 70, type: 'number', cellClassName: 'font-mono' },
    // rate fields
    { field: 'pod',    headerName: 'Port of Discharge', flex: 1.1, minWidth: 86, editable: true },
    { field: 'lastCy', headerName: 'Last CY',           flex: 0.9, minWidth: 80, editable: true },
    {
      field: 'rate',
      headerName: 'Rate/Unit',
      width: 86,
      editable: true,
      type: 'number',
      cellClassName: 'font-mono',
    },
    {
      field: 'freeDays',
      headerName: '# of Free Days',
      width: 82,
      editable: true,
      type: 'number',
      cellClassName: 'font-mono',
    },
    { field: 'carrier', headerName: 'Carrier', flex: 0.9, minWidth: 80, editable: true },
    {
      field: 'validUntil',
      headerName: 'Valid Until',
      width: 102,
      editable: true,
      type: 'date',
    },
    { field: 'remarks', headerName: 'Remarks', flex: 1, minWidth: 86, editable: true },
    {
      field: 'actions',
      headerName: '',
      width: 40,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
        <button
          className="rounded-md p-1 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
          onClick={() => handleDeleteRow(params.row)}
          tabIndex={-1}
          title={params.row.laneId ? 'Skip this lane' : 'Remove this row'}
        >
          <Trash2 size={15} />
        </button>
      ),
    },
  ]

  /* ── row editing ─────────────────────────────────────────────────────── */

  const processRowUpdate = useCallback((newRow) => {
    setRows((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

  const handleAddRow = () => setRows((prev) => [...prev, makeEmptyRow()])

  const handleDeleteRow = async (row) => {
    // Free/independent row — never persisted, so just drop it locally.
    if (!row.laneId) {
      setRows((prev) => {
        const filtered = prev.filter((r) => r.id !== row.id)
        return filtered.length === 0 ? [makeEmptyRow()] : filtered
      })
      return
    }

    // Lane-linked row — persist a skip so it stays cleared (PVM §3).
    setRows((prev) => prev.filter((r) => r.id !== row.id)) // optimistic
    const { error } = await skipLane(row.laneId, row.period)
    if (error) {
      showToast('error', `Couldn’t skip lane: ${error.message}`)
      loadLanes() // restore truth
    } else {
      showToast('success', 'Lane skipped', { label: 'Undo', onClick: () => handleUndoSkip(row) })
    }
  }

  const handleUndoSkip = async (row) => {
    const { error } = await unskipLane(row.laneId, row.period)
    if (error) {
      showToast('error', `Couldn’t undo: ${error.message}`)
    } else {
      // bring the lane back without disturbing other in-progress rows
      setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
    }
  }

  /* ── CSV upload (independent rates) ──────────────────────────────────── */

  const handleCsvUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete(results) {
        const parsed = results.data
          .map(makeRowFromCsv)
          .filter((r) => r.pol || r.rate !== '') // drop fully empty rows
        if (parsed.length === 0) {
          showToast('warning', 'CSV had no usable rows. Expected columns like POL, Rate.')
          return
        }
        // drop the blank placeholder row(s), then append the parsed rates
        setRows((prev) => [...prev.filter((r) => !isBlankRow(r)), ...parsed])
        showToast('success', `Loaded ${parsed.length} rate(s) from CSV`)
      },
      error() {
        showToast('error', 'Failed to parse CSV file')
      },
    })

    e.target.value = '' // allow re-selecting the same file
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  const rateCount = filledRows.length
  const hasRequests = rows.some((r) => r.laneId)

  const handleSubmit = async () => {
    if (rateCount === 0) {
      showToast('warning', 'Fill in at least one rate (Rate/Unit) before submitting')
      return
    }
    setSubmitting(true)
    const { error, count } = await submitRates(filledRows)
    setSubmitting(false)

    if (error) {
      showToast('error', `Submit failed: ${error.message}`)
    } else {
      showToast('success', `Submitted ${count} rate(s)`)
      loadLanes() // reset to a clean slate
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Freight Forwarder · Rates"
        title="Submit Rates"
        subtitle={
          hasRequests
            ? 'Lanes requested by your customers. Fill in your rate for each — or add rows / upload a CSV for rates outside these requests.'
            : 'No open requests right now — add rates directly or upload a CSV to submit them independently.'
        }
        actions={
          <span className="inline-flex items-center gap-2 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
            <span className="font-mono text-lg font-semibold leading-none text-harbor-900">{rateCount}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400">
              {rateCount === 1 ? 'rate' : 'rates'} ready
            </span>
          </span>
        }
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={handleAddRow}
        >
          <Plus size={16} />
          Add Row
        </button>
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={16} />
          Upload CSV
        </button>
        <input ref={fileInputRef} type="file" accept=".csv" hidden onChange={handleCsvUpload} />

        <div className="flex-1" />

        <button
          className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          onClick={handleSubmit}
          disabled={submitting || loading || rateCount === 0}
        >
          <Send size={16} className="transition-transform group-hover:translate-x-0.5" />
          {submitting ? 'Submitting…' : 'Submit Rates'}
        </button>
      </div>

      {/* Body: loading / error / grid */}
      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load lanes: {loadError}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
          <DataGrid
            rows={rows}
            columns={columns}
            processRowUpdate={processRowUpdate}
            disableRowSelectionOnClick
            hideFooter
            autoHeight
            sx={{
              border: 'none',
              fontFamily: '"Hanken Grotesk", ui-sans-serif, sans-serif',
              '& .MuiDataGrid-columnHeaders': {
                backgroundColor: '#f7f8fa',
                borderBottom: '1px solid #dfe4ea',
              },
              '& .MuiDataGrid-columnHeader': {
                fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                fontSize: '0.62rem',
                fontWeight: 600,
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
                color: '#566270',
                padding: '0 8px',
              },
              '& .MuiDataGrid-columnSeparator': { color: '#eef1f4' },
              '& .MuiDataGrid-cell': {
                fontSize: '0.8rem',
                color: '#132236',
                borderColor: '#eef1f4',
                padding: '0 8px',
              },
              '& .MuiDataGrid-row:hover': { backgroundColor: '#f7f8fa' },
              '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
                outline: '2px solid rgba(245,165,36,0.5)',
                outlineOffset: '-2px',
              },
              '& .MuiDataGrid-cell--editing': {
                boxShadow: 'inset 0 0 0 2px rgba(245,165,36,0.5)',
              },
            }}
          />
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-card-hover animate-rise-in ${TOAST_COLORS[toast.severity]}`}>
          <span>{toast.message}</span>
          {toast.action && (
            <button
              className="rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide underline-offset-2 transition-colors hover:bg-white/20"
              onClick={() => {
                toast.action.onClick()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button
            className="rounded-md p-0.5 transition-colors hover:bg-white/20"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
