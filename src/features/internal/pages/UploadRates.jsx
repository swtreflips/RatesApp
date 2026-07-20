import React, { useState, useCallback, useEffect, useRef } from 'react'
import { DataGrid, useGridApiContext } from '@mui/x-data-grid'
import { Trash2, Copy, Plus, Upload, Send, Loader2 } from 'lucide-react'
import { PageHeader } from '../../../components/ui/DashboardPrimitives'
import { fetchOpenRequests } from '../services/rateRequestService'
import { fetchForwarders, submitRatesOnBehalf } from '../services/recordRatesService'
import {
  makeEmptyRow, makeRowFromLane, makeCopyRow, CarrierGhostInput, AutocompleteEditCell,
  buildHeaderIndex, makeRowFromCsv, isBlankRow, parseRateFile, DATA_GRID_SX, gridScrollHeight, Toast,
  CONTAINER_TYPE_OPTIONS,
} from '../../rates/rateGrid'
import { PORTS_OF_LOADING, PORTS_OF_DISCHARGE, LAST_CY_OPTIONS, FINAL_DESTINATIONS } from '../../rates/locationOptions'

/*
  Internal "Upload Rates" — record rates on behalf of a forwarder.

  Same grid as the forwarder Submit Rates page, with ONE extra required column: Forwarder (who
  the rate belongs to) — a type-ahead autocomplete over the forwarders list, bound to the
  forwarder id (restricted to the list). The open request lanes preload as guide rows; the
  internal user picks a forwarder + fills the rate, or uploads the filled template / a CSV.

  One lane carries rates from SEVERAL forwarders: add each forwarder's quote with copy-row (or
  multiple CSV rows for the same lane). Uniqueness is per (lane, forwarder, period) — the service
  creates one acknowledgement per forwarder — so they never collapse together.

  Recorded rates attach to the matching open lane (by POL+FD) and create the same acknowledgement,
  so they look identical to a forwarder's own submission in Active/Received Rates. Writes require
  the internal-write RLS policies (plan.md §1).
*/

const norm = (s) => String(s ?? '').trim().toLowerCase()

// Inline ghost completion appears only after this many typed characters.
const FORWARDER_MIN_CHARS = 3

/* DataGrid edit cell for the Forwarder column. A plain text input (accepts ANY value) that, once
   ≥ FORWARDER_MIN_CHARS are typed, shows the best prefix match as faint inline "ghost" text;
   Tab / → accepts it. The cell stores the typed NAME; it's resolved to a forwarder id at submit
   (unknown names are rejected there). No dropdown, no arrow. */
function ForwarderGhostInput({ id, field, value, forwarders }) {
  const apiRef = useGridApiContext()
  const inputRef = useRef(null)
  const text = value ?? ''

  const suggestion = text.trim().length >= FORWARDER_MIN_CHARS
    ? (forwarders.find((f) => f.name.toLowerCase().startsWith(text.toLowerCase()))?.name ?? '')
    : ''
  const ghost = suggestion.length > text.length ? suggestion.slice(text.length) : ''

  const setValue = (v) => apiRef.current.setEditCellValue({ id, field, value: v })

  const onKeyDown = (e) => {
    if (!ghost) return
    const atEnd = inputRef.current && inputRef.current.selectionStart === text.length
    if (e.key === 'Tab' || (e.key === 'ArrowRight' && atEnd)) {
      e.preventDefault()
      setValue(suggestion)
    }
  }

  return (
    <div className="relative flex h-full w-full items-center px-2">
      {/* ghost overlay: invisible typed text reserves width, then the faint completion */}
      <div className="pointer-events-none absolute inset-0 flex items-center px-2 font-sans text-[0.8rem]">
        <span className="invisible whitespace-pre">{text}</span>
        <span className="whitespace-pre text-fog-400">{ghost}</span>
      </div>
      <input
        ref={inputRef}
        autoFocus
        className="relative z-10 h-full w-full border-0 bg-transparent p-0 font-sans text-[0.8rem] text-harbor-900 outline-none"
        value={text}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

export default function UploadRates() {
  const [rows, setRows] = useState([])
  const [forwarders, setForwarders] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState(null)
  const fileInputRef = useRef(null)
  // lookup tables rebuilt on load
  const laneIndexRef = useRef(new Map())   // `${pol}|${fd}` → { laneId, period }
  const nameToIdRef = useRef(new Map())    // forwarder name (lower) → id

  /* ── load forwarders + open lanes ────────────────────────────────────── */

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const [{ forwarders, error: fErr }, { lanes, error: lErr }] = await Promise.all([
      fetchForwarders(),
      fetchOpenRequests(),
    ])
    if (fErr || lErr) {
      setLoadError((fErr || lErr).message)
      setLoading(false)
      return
    }
    setForwarders(forwarders)
    nameToIdRef.current = new Map(forwarders.map((f) => [norm(f.name), f.id]))
    laneIndexRef.current = new Map(
      (lanes ?? []).map((l) => [`${norm(l.pol)}|${norm(l.fd)}`, { laneId: l.id, period: l.period }])
    )
    setRows(lanes.length ? lanes.map(makeRowFromLane) : [makeEmptyRow()])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

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
    {
      field: 'forwarderName',
      headerName: 'Forwarder',
      width: 180,
      editable: true,
      // free-text with inline ghost completion; resolved to an id at submit
      renderCell: (params) => params.value ?? '',
      renderEditCell: (params) => <ForwarderGhostInput {...params} forwarders={forwarders} />,
    },
    {
      field: 'contract',
      headerName: 'Contract',
      width: 130,
      editable: true,
      // free text; only contract forwarders carry a value — blank for the rest
      cellClassName: 'font-mono',
    },
    {
      field: 'contractName',
      headerName: 'Contract Name',
      width: 150,
      editable: true,
      // free text; pairs with Contract — blank for non-contract rates
    },
    { field: 'pol',    headerName: 'Port of Loading',   flex: 1.1, minWidth: 86, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={PORTS_OF_LOADING} /> },
    // template guides (request-side; preloaded from the lane)
    { field: 'fd',     headerName: 'Final Destination', flex: 1.1, minWidth: 86, editable: true,
      renderEditCell: (p) => <AutocompleteEditCell {...p} options={FINAL_DESTINATIONS} /> },
    // Editable: part of the ocean rate's identity (BIDDING.md §6). Blank = the 40' HC standard.
    { field: 'containerType', headerName: 'Cont. Type', width: 96, cellClassName: 'font-mono',
      editable: true, type: 'singleSelect', valueOptions: CONTAINER_TYPE_OPTIONS },
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
            title="Duplicate this row (e.g. another forwarder's quote)"
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
    },
  ]

  /* ── row editing ─────────────────────────────────────────────────────── */

  const processRowUpdate = useCallback((newRow) => {
    setRows((prev) => prev.map((r) => (r.id === newRow.id ? newRow : r)))
    return newRow
  }, [])

  const handleAddRow = () => setRows((prev) => [...prev, makeEmptyRow()])

  const handleCopyRow = (row) => setRows((prev) => {
    const idx = prev.findIndex((r) => r.id === row.id)
    const next = [...prev]
    next.splice(idx === -1 ? next.length : idx + 1, 0, makeCopyRow(row))
    return next
  })

  // Plain removal — no skip concept on the internal side.
  const handleDeleteRow = (row) => setRows((prev) => {
    const filtered = prev.filter((r) => r.id !== row.id)
    return filtered.length === 0 ? [makeEmptyRow()] : filtered
  })

  /* ── CSV / XLSX / template upload ─────────────────────────────────────── */

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
          .filter((r) => r.pol || r.rate !== '' || r.carrier.length > 0)
          .map((r) => {
            // match to an open lane by POL + FD → attach; else standalone. The forwarder name is
            // kept as typed and resolved to an id at submit.
            const match = laneIndexRef.current.get(`${norm(r.pol)}|${norm(r.fd)}`)
            return { ...r, laneId: match?.laneId ?? null, period: match?.period ?? null }
          })

        if (parsed.length === 0) {
          showToast('warning', 'CSV had no usable rows. Expected columns like Forwarder, POL, Rate.')
          return
        }
        setRows((prev) => [...prev.filter((r) => !isBlankRow(r)), ...parsed])
        const matched = parsed.filter((r) => r.laneId).length
        showToast('success', `Loaded ${parsed.length} rate(s) — ${matched} matched to open lanes`)
      },
      error() {
        showToast('error', 'Failed to read file')
      },
    })

    e.target.value = ''
  }

  /* ── submit ──────────────────────────────────────────────────────────── */

  const filledRows = rows.filter((r) => r.rate !== '' && r.rate != null)
  const rateCount = filledRows.reduce((n, r) => n + Math.max((r.carrier ?? []).length, 1), 0)

  const handleSubmit = async () => {
    if (rateCount === 0) {
      showToast('warning', 'Fill in at least one rate (Rate/Unit) before submitting')
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
    const { error, count } = await submitRatesOnBehalf(resolved)
    setSubmitting(false)

    if (error) {
      showToast('error', `Submit failed: ${error.message}`)
    } else {
      showToast('success', `Recorded ${count} rate(s)`)
      load() // reset to a clean slate
    }
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Internal · Rates"
        title="Upload Rates"
        subtitle="Record rates a forwarder sent — pick the forwarder, fill in the rate (or upload their sheet). Recorded rates attach to your open lanes, just like a forwarder's own submission."
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
          {submitting ? 'Recording…' : 'Record Rates'}
        </button>
      </div>

      {/* Body: loading / error / grid */}
      {loading ? (
        <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-fog-200 bg-white shadow-card">
          <Loader2 size={24} className="animate-spin text-fog-400" />
        </div>
      ) : loadError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700 shadow-card">
          Couldn’t load: {loadError}
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
