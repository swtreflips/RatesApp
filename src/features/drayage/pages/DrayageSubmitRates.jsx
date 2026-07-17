import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Copy, Plus, Upload, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast } from '../../rates/rateGrid'
import {
  makeDrayEmptyRow, makeDrayRowFromLane, makeDrayCopyRow, isDrayBlankRow,
  buildDrayHeaderIndex, makeDrayRowFromCsv, drayColumns,
} from '../drayageGrid'
import { fetchDrayageLanes, submitDrayageRates, skipDrayageLane, unskipDrayageLane } from '../services/drayageService'

/*
  Forwarder drayage entry grid — mirror of the ocean SubmitRates flow with drayage columns
  (DRAY.md §6a). Open request lanes preload as guide rows; free rows / template upload submit
  proactive rates with no request (§6c). Fuel: fill EITHER Fuel % OR Fuel $ — the database
  derives the other and the total (§6d); the Total column is a client-side preview only.
  Submitting a lane you already have a live rate on SUPERSEDES it (§6b).
*/

export default function DrayageSubmitRates() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)

  const loadLanes = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const { lanes, error } = await fetchDrayageLanes()
    if (error) setLoadError(error.message)
    else setRows(lanes.length ? lanes.map(makeDrayRowFromLane) : [makeDrayEmptyRow()])
    setLoading(false)
  }, [])

  useEffect(() => { loadLanes() }, [loadLanes])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  const showToast = (severity, message, action = null) => setToast({ severity, message, action })

  /* ── rows ────────────────────────────────────────────────────────────── */

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

  const handleDeleteRow = async (row) => {
    const isPrimaryLaneRow = row.laneId && row.id === row.laneId
    if (!isPrimaryLaneRow) {
      setRows((prev) => {
        const filtered = prev.filter((r) => r.id !== row.id)
        return filtered.length === 0 ? [makeDrayEmptyRow()] : filtered
      })
      return
    }
    setRows((prev) => prev.filter((r) => r.id !== row.id)) // optimistic
    const { error } = await skipDrayageLane(row.laneId)
    if (error) {
      showToast('error', `Couldn’t skip lane: ${error.message}`)
      loadLanes()
    } else {
      showToast('success', 'Lane skipped', {
        label: 'Undo',
        onClick: async () => {
          const { error: undoErr } = await unskipDrayageLane(row.laneId)
          if (undoErr) showToast('error', `Couldn’t undo: ${undoErr.message}`)
          else setRows((prev) => (prev.some((r) => r.id === row.id) ? prev : [...prev, row]))
        },
      })
    }
  }

  const columns = drayColumns({
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
          title={params.row.id === params.row.laneId ? 'Skip this lane' : 'Remove this row'}
        >
          <Trash2 size={15} />
        </button>
      </div>
    ),
  })

  /* ── template upload (proactive rates, §6c) ──────────────────────────── */

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
          showToast('warning', 'No usable rows. Expected drayage template columns (Last CY/CFS, Final Destination, Rate…).')
          return
        }
        setRows((prev) => [...prev.filter((r) => !isDrayBlankRow(r)), ...parsed])
        showToast('success', `Loaded ${parsed.length} rate(s)`)
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })
    e.target.value = ''
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  const hasRequests = rows.some((r) => r.laneId)

  const handleSubmit = async () => {
    if (filledRows.length === 0) {
      showToast('warning', 'Fill in at least one Rate before submitting')
      return
    }
    setSubmitting(true)
    const { error, count } = await submitDrayageRates(filledRows)
    setSubmitting(false)
    if (error) {
      showToast('error', `Submit failed: ${error.message}`)
    } else {
      showToast('success', `Submitted ${count} rate(s)`)
      loadLanes()
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Freight Forwarder · Drayage"
        title="Submit Drayage Rates"
        subtitle={
          hasRequests
            ? 'Drayage lanes requested by your customers. Fill Rate plus EITHER Fuel % or Fuel $ — the other and the Total compute automatically. New rates replace your previous rate on the same lane.'
            : 'No open drayage requests right now — add rates directly or upload the drayage template to submit them independently.'
        }
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
          disabled={submitting || loading || filledRows.length === 0}
        >
          <Send size={16} className="transition-transform group-hover:translate-x-0.5" />
          {submitting ? 'Submitting…' : 'Submit Rates'}
        </button>
      </div>

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
            tabNavigation="content"
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(rows.length) }}
          />
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
