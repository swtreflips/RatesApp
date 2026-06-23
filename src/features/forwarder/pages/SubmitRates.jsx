import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid } from '@mui/x-data-grid'
import { Trash2, Copy, Plus, Upload, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { fetchActiveLanes, submitRates, skipLane, unskipLane } from '../services/submissionService'
import {
  makeEmptyRow, makeRowFromLane, makeCopyRow, CarrierGhostInput, AutocompleteEditCell,
  buildHeaderIndex, makeRowFromCsv, isBlankRow, parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast,
} from '../../rates/rateGrid'
import { PORTS_OF_LOADING, PORTS_OF_DISCHARGE, LAST_CY_OPTIONS } from '../../rates/locationOptions'

/*
  Forwarder rate-entry grid — unified (request-driven + free entry). Shared grid primitives
  (carrier parsing, row factories, CSV parser, styling, toast) live in features/rates/rateGrid.

  - Active lanes preload as guide rows (POL · FD · Container Type · # Containers; FD/type/count
    are request-side guides, not part of a rate).
  - The forwarder can also add free rows or upload a CSV for rates independent of any request
    (PROVIDER_VIEW_MODEL §4) — those carry no laneId → written with null lane_id/submission_id/period.

  A rate = POL · POD · Last CY · Rate/Unit · Free Days · Carrier · Valid Until · Remarks.
*/

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
    { field: 'pol',    headerName: 'Port of Loading',   flex: 1.1, minWidth: 86, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={PORTS_OF_LOADING} /> },
    // template guides (request-side only; blank for free rows)
    { field: 'fd',     headerName: 'Final Destination', flex: 1.1, minWidth: 86 },
    { field: 'containerType', headerName: 'Cont. Type', width: 88, cellClassName: 'font-mono' },
    { field: 'containerCount', headerName: '# Cont.', width: 70, type: 'number', cellClassName: 'font-mono' },
    // rate fields
    { field: 'pod',    headerName: 'Port of Discharge', flex: 1.1, minWidth: 86, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={PORTS_OF_DISCHARGE} /> },
    { field: 'lastCy', headerName: 'Last CY',           flex: 0.9, minWidth: 80, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={LAST_CY_OPTIONS} /> },
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
    {
      field: 'carrier',
      headerName: 'Carrier',
      flex: 1,
      minWidth: 96,
      editable: true,
      // multi-value codes; inline ghost completion after the 1st char
      renderCell: (params) => (params.value ?? []).join(', '),
      renderEditCell: (params) => <CarrierGhostInput {...params} />,
    },
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
      width: 72,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
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
    },
  ]

  /* ── row editing ─────────────────────────────────────────────────────── */

  const processRowUpdate = useCallback((newRow) => {
    setRows((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

  const handleAddRow = () => setRows((prev) => [...prev, makeEmptyRow()])

  // Duplicate a row, dropping the copy directly below its source so the grid stays ordered.
  const handleCopyRow = (row) => setRows((prev) => {
    const idx = prev.findIndex((r) => r.id === row.id)
    const next = [...prev]
    next.splice(idx === -1 ? next.length : idx + 1, 0, makeCopyRow(row))
    return next
  })

  const handleDeleteRow = async (row) => {
    // Free rows and copies (temp id ⇒ id !== laneId) are never persisted on their own —
    // drop them locally. Only the lane's primary row (id === laneId) persists a skip.
    const isPrimaryLaneRow = row.laneId && row.id === row.laneId
    if (!isPrimaryLaneRow) {
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

  /* ── CSV / XLSX upload (independent rates) ───────────────────────────── */

  // Parse positionally (header: false) so we can reach the unnamed trailing carrier columns the
  // forwarders append. Row 0 is the header; remaining rows are data. .xlsx → first sheet as CSV.
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
        const headerIndex = buildHeaderIndex(headerCells)
        const parsed = dataRows
          .map((cells) => makeRowFromCsv(cells, headerIndex))
          .filter((r) => r.pol || r.rate !== '' || r.carrier.length > 0) // drop fully empty rows
        if (parsed.length === 0) {
          showToast('warning', 'CSV had no usable rows. Expected columns like POL, Rate.')
          return
        }
        // drop the blank placeholder row(s), then append the parsed rates
        setRows((prev) => [...prev.filter((r) => !isBlankRow(r)), ...parsed])
        showToast('success', `Loaded ${parsed.length} rate(s)`)
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })

    e.target.value = '' // allow re-selecting the same file
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  // each filled row fans out into one rate per carrier (≥1, so a carrier-less row still counts as one)
  const rateCount = filledRows.reduce((n, r) => n + Math.max((r.carrier ?? []).length, 1), 0)
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
          Upload File
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" hidden onChange={handleFileUpload} />

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
            tabNavigation="content"
            disableRowSelectionOnClick
            hideFooter
            sx={{ ...DATA_GRID_SX, height: gridScrollHeight(rows.length) }}
          />
        </div>
      )}

      {/* Toast */}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  )
}
