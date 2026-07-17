import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Copy, Plus, Upload, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import {
  makeDrayEmptyRow, makeDrayCopyRow, isDrayBlankRow,
  buildDrayHeaderIndex, makeDrayRowFromCsv, drayColumns,
} from '../drayageGrid'
import { submitDrayageRatesOnBehalf } from '../services/drayageService'
import { fetchForwarders } from '../../internal/services/recordRatesService'

/*
  Internal "Upload Drayage Rates" — record rates ON BEHALF of a forwarder (the returned
  template lands with us, we key it in). Same columns as the forwarder grid plus the
  Forwarder picker; every row must name its forwarder. Supersession applies exactly as if
  the forwarder submitted it themselves (§6b): the company's live rate on that lane is
  replaced by the uploaded one.
*/

export default function DrayageUploadRates() {
  const [rows, setRows] = useState([makeDrayEmptyRow()])
  const [forwarders, setForwarders] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => {
    fetchForwarders().then(({ forwarders }) => setForwarders(forwarders))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message) => setToast({ severity, message })

  const processRowUpdate = useCallback((newRow) => {
    setRows((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

  const handleAddRow = () => setRows((prev) => [...prev, makeDrayEmptyRow()])
  const handleCopyRow = (row) => setRows((prev) => {
    const idx = prev.findIndex((r) => r.id === row.id)
    const next = [...prev]
    next.splice(idx === -1 ? next.length : idx + 1, 0, makeDrayCopyRow(row))
    return next
  })
  const handleDeleteRow = (row) => setRows((prev) => {
    const filtered = prev.filter((r) => r.id !== row.id)
    return filtered.length === 0 ? [makeDrayEmptyRow()] : filtered
  })

  const forwarderCol = {
    field: 'forwarderId',
    headerName: 'Forwarder',
    width: 170,
    editable: true,
    type: 'singleSelect',
    valueOptions: forwarders.map((f) => ({ value: f.id, label: f.name })),
    renderCell: (params) => {
      const f = forwarders.find((x) => x.id === params.value)
      return f ? f.name : <span className="text-red-400">pick…</span>
    },
  }

  const columns = drayColumns({
    extraLeading: [forwarderCol],
    renderActions: (params) => (
      <div className="flex items-center gap-0.5">
        <button
          className="rounded-md p-1 text-fog-400 transition-colors hover:bg-harbor-50 hover:text-harbor-700"
          onClick={() => handleCopyRow(params.row)}
          tabIndex={-1}
          title="Duplicate this row"
        >
          <Copy size={15} />
        </button>
        <button
          className="rounded-md p-1 text-fog-400 transition-colors hover:bg-red-50 hover:text-red-600"
          onClick={() => handleDeleteRow(params.row)}
          tabIndex={-1}
          title="Remove this row"
        >
          <Trash2 size={15} />
        </button>
      </div>
    ),
  })

  /* ── template upload ─────────────────────────────────────────────────── */

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    parseRateFile(file, {
      complete(results) {
        const [headerCells, ...dataRows] = results.data
        if (!headerCells) {
          showToast('warning', 'File had no rows.')
          return
        }
        const headerIndex = buildDrayHeaderIndex(headerCells)
        const parsed = dataRows
          .map((cells) => makeDrayRowFromCsv(cells, headerIndex))
          .filter((r) => r.origin || r.destination || r.rate !== '')
        if (parsed.length === 0) {
          showToast('warning', 'No usable rows. Expected drayage template columns.')
          return
        }
        setRows((prev) => [...prev.filter((r) => !isDrayBlankRow(r)), ...parsed])
        showToast('success', `Loaded ${parsed.length} rate(s) — assign the forwarder per row`)
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })
    e.target.value = ''
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  const missingForwarder = filledRows.some((r) => !r.forwarderId)

  const handleSubmit = async () => {
    if (filledRows.length === 0) {
      showToast('warning', 'Fill in at least one Rate before submitting')
      return
    }
    if (missingForwarder) {
      showToast('warning', 'Pick a forwarder for every filled row')
      return
    }
    setSubmitting(true)
    const { error, count } = await submitDrayageRatesOnBehalf(filledRows)
    setSubmitting(false)
    if (error) {
      showToast('error', `Submit failed: ${error.message}`)
    } else {
      showToast('success', `Recorded ${count} rate(s)`)
      setRows([makeDrayEmptyRow()])
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Drayage"
        title="Upload Drayage Rates"
        subtitle="Record drayage rates a forwarder sent back outside the app. Pick the forwarder per row — their live rate on the same lane is superseded by what you record."
        actions={
          <span className="inline-flex items-center gap-2 rounded-lg border border-fog-200 bg-white px-3 py-1.5 shadow-card">
            <span className="font-mono text-lg font-semibold leading-none text-harbor-900">{filledRows.length}</span>
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400">
              {filledRows.length === 1 ? 'rate' : 'rates'} ready
            </span>
          </span>
        }
      />

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
          Upload File
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleFileUpload} />

        <div className="flex-1" />

        <button
          className="group inline-flex items-center gap-2 rounded-lg bg-signal-500 px-4 py-2 text-sm font-semibold text-harbor-950 shadow-signal transition-all hover:bg-signal-400 hover:shadow-card-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          onClick={handleSubmit}
          disabled={submitting || filledRows.length === 0}
        >
          <Send size={16} className="transition-transform group-hover:translate-x-0.5" />
          {submitting ? 'Recording…' : 'Record Rates'}
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card" style={{ width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          processRowUpdate={processRowUpdate}
          tabNavigation="content"
          disableRowSelectionOnClick
          hideFooter
          sx={{ ...DATA_GRID_SX, height: gridScrollHeight(rows.length) }}
        />
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
