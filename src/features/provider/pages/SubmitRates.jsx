import React, { useState, useCallback, useEffect } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Plus, Send, X } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'

/*
  MOCK rate-entry grid for the provider.

  There is no Supabase database yet, so the "Open Requests" a forwarder responds
  to are seeded here as sample lanes. In the real flow these rows will be the
  active rate-request lanes (POL pre-filled from the requester's template); the
  forwarder fills in the rate columns and submits.

  Columns — from the request template: Port of Loading · Final Destination ·
  Container Type · # Containers; filled by the forwarder: Port of Discharge ·
  Last CY · Rate/Unit · # of Free Days · Carrier · Valid Until · Remarks
*/

let nextId = 1
const makeRow = (template = {}) => ({
  id: nextId++,
  // From the request template (set by the requester)
  pol: template.pol ?? '',
  fd: template.fd ?? '',
  containerType: template.containerType ?? '',
  containerCount: template.containerCount ?? '',
  // Rate fields the forwarder fills in
  pod: '',
  lastCy: '',
  rate: '',
  freeDays: '',
  carrier: '',
  validUntil: null,
  remarks: '',
})

const CONTAINER_TYPES = ['20GP', '40GP', '40HC', '45HC', '20RF', '40RF']

// Sample lanes standing in for requester-originated templates.
const SAMPLE_LANES = [
  { pol: 'Nhava Sheva, India', fd: 'Commerce, CA', containerType: '40HC', containerCount: 5 },
  { pol: 'Mundra, India',      fd: 'Dallas, TX',   containerType: '40GP', containerCount: 3 },
  { pol: 'Shanghai, China',    fd: 'Chicago, IL',  containerType: '40HC', containerCount: 2 },
]
const makeInitialRows = () => SAMPLE_LANES.map((l) => makeRow(l))

const TOAST_COLORS = {
  success: 'bg-sea-600',
  warning: 'bg-signal-600',
  error:   'bg-red-600',
}

export default function SubmitRates() {
  const [rows, setRows] = useState(makeInitialRows)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)

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
    { field: 'pol',     headerName: 'Port of Loading',   flex: 1.1, minWidth: 86, editable: true },
    { field: 'fd',      headerName: 'Final Destination', flex: 1.1, minWidth: 86, editable: true },
    {
      field: 'containerType',
      headerName: 'Cont. Type',
      width: 88,
      editable: true,
      type: 'singleSelect',
      cellClassName: 'font-mono',
      valueOptions: CONTAINER_TYPES,
    },
    {
      field: 'containerCount',
      headerName: '# Cont.',
      width: 70,
      editable: true,
      type: 'number',
      cellClassName: 'font-mono',
    },
    { field: 'pod',     headerName: 'Port of Discharge', flex: 1.1, minWidth: 86, editable: true },
    { field: 'lastCy',  headerName: 'Last CY',           flex: 0.9, minWidth: 80, editable: true },
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

  const handleAddRow = () => setRows((prev) => [...prev, makeRow()])

  const handleDeleteRow = (id) => {
    setRows((prev) => {
      const filtered = prev.filter((r) => r.id !== id)
      return filtered.length === 0 ? [makeRow()] : filtered
    })
  }

  /* ── submit (mock) ───────────────────────────────────────────────────── */

  const rateCount = rows.filter((r) => r.pol.trim() && r.rate !== '' && r.rate != null).length

  const handleSubmit = () => {
    if (rateCount === 0) {
      showToast('warning', 'Add at least one rate (Port of Loading + Rate/Unit)')
      return
    }
    setSubmitting(true)
    // No database yet — simulate a submit so the flow can be exercised.
    setTimeout(() => {
      setSubmitting(false)
      showToast('success', `Submitted ${rateCount} rate(s) — mock only, no database connected yet`)
    }, 500)
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
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-fog-300 bg-white px-3 py-2 text-sm font-medium text-harbor-700 shadow-sm transition-all hover:border-harbor-300 hover:bg-fog-50 hover:text-harbor-900"
          onClick={handleAddRow}
        >
          <Plus size={16} />
          Add Row
        </button>

        <div className="flex-1" />

        <button
          className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          onClick={handleSubmit}
          disabled={submitting}
        >
          <Send size={16} className="transition-transform group-hover:translate-x-0.5" />
          {submitting ? 'Submitting…' : 'Submit Rates'}
        </button>
      </div>

      {/* DataGrid */}
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
