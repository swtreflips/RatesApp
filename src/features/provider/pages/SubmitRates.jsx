import React, { useState, useCallback, useEffect } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Send, X, Loader2, Inbox } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { fetchActiveLanes, submitRates } from '../services/submissionService'

/*
  Provider rate-entry grid (STEP 0 / S0.5 — real).

  Rows are the requester's ACTIVE lanes (one row per lane). The template columns
  (POL · FD · Container Type · # Containers) come from the lane and are read-only;
  the forwarder fills the rate columns (POD · Last CY · Rate · Free Days · Carrier
  · Valid Until · Remarks) and submits. Each row carries laneId + period so the
  submission ties back to the lane.

  Not in this slice: skip, multi-carrier explode, .xlsx upload, latest-per-routing.
*/

const CONTAINER_TYPES = ['20GP', '40GP', '40HC', '45HC', '20RF', '40RF']

const makeRowFromLane = (lane) => ({
  id: lane.id,            // grid id = lane id (stable, unique)
  laneId: lane.id,
  period: lane.period,
  // from the request template (read-only)
  pol: lane.pol ?? '',
  fd: lane.fd ?? '',
  containerType: lane.container_type ?? '',
  containerCount: lane.container_count ?? '',
  // rate fields the forwarder fills in
  pod: '',
  lastCy: '',
  rate: '',
  freeDays: '',
  carrier: '',
  validUntil: null,
  remarks: '',
})

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

  /* ── load active lanes ───────────────────────────────────────────────── */

  const loadLanes = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const { lanes, error } = await fetchActiveLanes()
    if (error) setLoadError(error.message)
    else setRows(lanes.map(makeRowFromLane))
    setLoading(false)
  }, [])

  useEffect(() => { loadLanes() }, [loadLanes])

  /* ── auto-dismiss toast ──────────────────────────────────────────────── */

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message) => setToast({ severity, message })

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
    { field: 'pol', headerName: 'Port of Loading',   flex: 1.1, minWidth: 86 },
    { field: 'fd',  headerName: 'Final Destination', flex: 1.1, minWidth: 86 },
    {
      field: 'containerType',
      headerName: 'Cont. Type',
      width: 88,
      cellClassName: 'font-mono',
    },
    {
      field: 'containerCount',
      headerName: '# Cont.',
      width: 70,
      type: 'number',
      cellClassName: 'font-mono',
    },
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
      headerName: 'Free Days',
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
          onClick={() => handleDeleteRow(params.row.id)}
          tabIndex={-1}
          title="Remove this lane from your submission"
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

  const handleDeleteRow = (id) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  const rateCount = filledRows.length

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
      loadLanes() // reset the grid to a clean slate of active lanes
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Freight Forwarder · Open Requests"
        title="Open Requests"
        subtitle="Lanes requested by your customers. Fill in your rate for each, then submit."
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

      {/* Body: loading / error / empty / grid */}
      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load lanes: {loadError}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-2xl border border-fog-200 bg-white text-center shadow-card">
          <Inbox size={28} className="text-fog-300" />
          <p className="text-sm font-medium text-harbor-800">No open requests right now</p>
          <p className="max-w-xs text-xs text-fog-500">
            When a requester posts lanes, their active requests show up here for you to quote.
          </p>
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
