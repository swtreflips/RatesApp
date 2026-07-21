import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Copy, Plus, Upload, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast, ForwarderGhostInput } from '../../rates/rateGrid'
import {
  makeDrayEmptyRow, makeDrayCopyRow, isDrayBlankRow,
  buildDrayHeaderIndex, makeDrayRowFromCsv, drayColumns,
} from '../drayageGrid'
import { submitDrayageRatesOnBehalf } from '../services/drayageService'
import { fetchForwarders } from '../../internal/services/recordRatesService'

const norm = (s) => String(s ?? '').trim().toLowerCase()

/*
  Internal "Upload Drayage Rates" — record rates ON BEHALF of a forwarder (the returned
  template lands with us, we key it in). Same columns as the forwarder grid plus a Forwarder
  column: free-text with ghost-completion (mirrors ocean's Upload Rates), so a CSV/ERP export
  that already names the forwarder per row pre-fills it — no forced per-row manual re-pick.
  The typed name is resolved to a forwarder id at submit; unknown names are rejected there.
  Supersession applies exactly as if the forwarder submitted it themselves (§6b): the company's
  live rate on that lane is replaced by the uploaded one.
*/

export default function DrayageUploadRates() {
  const [rows, setRows] = useState([makeDrayEmptyRow()])
  const [forwarders, setForwarders] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)
  const nameToIdRef = useRef(new Map()) // forwarder name (lower) → id

  useEffect(() => {
    fetchForwarders().then(({ forwarders }) => {
      setForwarders(forwarders)
      nameToIdRef.current = new Map(forwarders.map((f) => [norm(f.name), f.id]))
    })
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
    field: 'forwarderName',
    headerName: 'Forwarder',
    width: 180,
    editable: true,
    // free-text with inline ghost completion; resolved to an id at submit
    renderCell: (params) => params.value ?? '',
    renderEditCell: (params) => <ForwarderGhostInput {...params} forwarders={forwarders} />,
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
        const named = parsed.filter((r) => r.forwarderName).length
        showToast('success', `Loaded ${parsed.length} rate(s) — ${named} with a forwarder from the file`)
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })
    e.target.value = ''
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)

  const handleSubmit = async () => {
    if (filledRows.length === 0) {
      showToast('warning', 'Fill in at least one Rate before submitting')
      return
    }
    // resolve each row's typed forwarder name → id; only known forwarders are accepted
    const resolved = filledRows.map((r) => ({
      ...r,
      forwarderId: r.forwarderName ? (nameToIdRef.current.get(norm(r.forwarderName)) ?? null) : null,
    }))
    const unknown = [...new Set(resolved.filter((r) => !r.forwarderId).map((r) => r.forwarderName || '(blank)'))]
    if (unknown.length > 0) {
      showToast('warning', `Unknown forwarder(s): ${unknown.join(', ')}`)
      return
    }
    setSubmitting(true)
    const { error, count } = await submitDrayageRatesOnBehalf(resolved)
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
        subtitle="Record drayage rates a forwarder sent back outside the app. The forwarder can come from the file (Forwarder/Carrier column) or be typed per row — their live rate on the same lane is superseded by what you record."
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
