/*
  Shared rate-entry grid building blocks — used by the forwarder "Submit Rates" page and the
  internal "Upload Rates" page. Pure, role-agnostic logic + the styled DataGrid sx + the Toast.
  Each page keeps its own columns + handlers (skip vs plain delete, lane preload source, the
  Forwarder column) and composes these primitives.

  A row's shape: lane guides (fd/containerType/containerCount), rate fields
  (pol/pod/lastCy/rate/freeDays/carrier[]/validUntil/remarks), laneId/period for grouping, and
  `forwarderId` + `contract`/`contractName` (used only by the internal grid; ignored by the forwarder grid).
*/

import React, { useState } from 'react'
import { X } from 'lucide-react'
import Papa from 'papaparse'
import { useGridApiContext } from '@mui/x-data-grid'

/* ── file upload (CSV or XLSX) ─────────────────────────────────────────────
   Turn an uploaded .csv OR .xlsx/.xls file into Papa results, then hand them to the caller's
   `complete` — so both grids share one parser and the CSV pipeline is identical for both file
   types. For a spreadsheet, the FIRST sheet is converted to CSV and run through the same parser
   (no xlsx-specific ingestion). SheetJS is imported lazily so it only loads for spreadsheets. */
const PAPA_OPTS = { header: false, skipEmptyLines: true }

export function parseRateFile(file, { complete, error }) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (ext === 'xlsx' || ext === 'xls') {
    file.arrayBuffer()
      .then(async (buf) => {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(buf, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]] // first sheet only
        if (!ws) return error?.()
        Papa.parse(XLSX.utils.sheet_to_csv(ws), { ...PAPA_OPTS, complete, error })
      })
      .catch(() => error?.())
  } else {
    Papa.parse(file, { ...PAPA_OPTS, complete, error })
  }
}

/* ── container types (OCEAN identity) ─────────────────────────────────────
   Part of an OCEAN rate's identity (BIDDING.md §6): ocean pricing differs by box size, so
   latest-per-routing dedup and bid targeting key on it. Drayage deliberately does NOT — a drayage
   move is priced per lane regardless of size (size only shifts accessorials), so drayage keeps its
   lane-only key.
   40' HC is the ~95% standard, so a blank cell is an INPUT convenience —
   `normalizeContainerType` resolves it to the default ON WRITE so the stored value is always
   total. (Never store null: Postgres treats nulls as distinct in unique indexes, which would let
   the same box size exist twice under different keys.) */
export const CONTAINER_TYPES = ["20' GP", "40' GP", "40' HC", "45' HC"]
export const DEFAULT_CONTAINER_TYPE = "40' HC"

/** Blank/unknown → the 40' HC standard; known values pass through trimmed. */
export const normalizeContainerType = (v) => {
  const s = String(v ?? '').trim()
  if (s === '') return DEFAULT_CONTAINER_TYPE
  const match = CONTAINER_TYPES.find((t) => t.toLowerCase() === s.toLowerCase())
  return match ?? s
}

/** Grid dropdown options — the blank entry is explicit so the default is reversible/visible. */
export const CONTAINER_TYPE_OPTIONS = [
  { value: '', label: `— ${DEFAULT_CONTAINER_TYPE} (default)` },
  ...CONTAINER_TYPES.map((t) => ({ value: t, label: t })),
]

/* ── carriers ─────────────────────────────────────────────────────────────
   SCAC-style codes. Trailing CSV cells matching one are read as carriers; anything else
   folds into Remarks. A row's `carrier` is an array of codes (one rate is written per code). */
export const CARRIER_CODES = new Set([
  'CMA', 'COS', 'EMC', 'HMM', 'HPL', 'MATS', 'MSC',
  'MSK', 'ONE', 'OOCL', 'SML', 'WHL', 'YML', 'ZIM',
])

export const normalizeCarrier = (v) => String(v ?? '').trim().toUpperCase()

// Comma-separated carrier string (manual grid entry) → deduped array of recognized codes.
export const splitCarriers = (text) =>
  [...new Set(String(text ?? '').split(',').map(normalizeCarrier).filter((c) => CARRIER_CODES.has(c)))]

/* Edit cell for the multi-value Carrier column.
   This one is NOT a plain text field, even though it looks like one: the Carrier column stores a
   validated ARRAY of SCAC codes, not the typed string, so the editor has to keep committing
   splitCarriers(). Deleting it in favour of the DataGrid default would silently start storing raw
   text in a column the rest of the app reads as string[]. Input is uppercased because codes are.
   No completion — you type the codes. */
export function CarrierCodesInput({ id, field, value }) {
  const apiRef = useGridApiContext()
  const [text, setText] = useState(() =>
    (Array.isArray(value) ? value.join(', ') : String(value ?? '')).toUpperCase())

  const commit = (t) => {
    const up = t.toUpperCase()
    setText(up)
    apiRef.current.setEditCellValue({ id, field, value: splitCarriers(up) })
  }

  return (
    <input
      autoFocus
      className="h-full w-full border-0 bg-transparent px-2 font-sans text-[0.8rem] text-harbor-900 outline-none"
      value={text}
      onChange={(e) => commit(e.target.value)}
    />
  )
}

/* The Forwarder column used to have a ghost-completion editor here, and POL / POD / Last CY /
   Final Destination had a suggestion dropdown (AutocompleteEditCell, fed by locationOptions.js).
   Both are gone: every one of those columns is now the DataGrid's own text editor. They were
   suggestion-only — freeSolo, free text always accepted, resolved/validated at submit — so
   nothing that was enforced moved. Only the prediction went. */


/* ── row factories ────────────────────────────────────────────────────────
   Temp ids are string-prefixed so they never collide with a lane's uuid id. */
let nextTempId = 1

export const makeEmptyRow = () => ({
  id: `new-${nextTempId++}`,
  laneId: null,
  period: null,
  forwarderName: '',        // internal "Upload Rates" only; the forwarder grid ignores it
  contract: '',             // internal "Upload Rates" only (contract forwarders); forwarder grid ignores it
  contractName: '',         // internal "Upload Rates" only; pairs with contract; forwarder grid ignores it
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
  carrier: [],
  validUntil: null,
  remarks: '',
})

export const makeRowFromLane = (lane) => ({
  id: lane.id,            // grid id = lane id (stable, unique)
  laneId: lane.id,
  period: lane.period,
  forwarderName: '',
  contract: '',
  contractName: '',
  // from the request template (read-only guides)
  fd: lane.fd ?? '',
  containerType: lane.container_type ?? '',
  containerCount: lane.container_count ?? '',
  // rate fields (POL/POD/Last CY prefilled from the template when the requester set them)
  pol: lane.pol ?? '',
  pod: lane.pod ?? '',
  lastCy: lane.last_cy ?? '',
  rate: '',
  freeDays: '',
  carrier: [],
  validUntil: null,
  remarks: '',
})

// Duplicate a row to quote another variation of the same lane (or another forwarder): carry the
// template fields + the forwarder, blank every rate field. Fresh temp id (id ≠ laneId) so it's
// never mistaken for the lane's primary row, while keeping laneId/period for grouping.
export const makeCopyRow = (source) => ({
  ...makeEmptyRow(),
  laneId: source.laneId ?? null,
  period: source.period ?? null,
  forwarderName: source.forwarderName ?? '',
  contract: source.contract ?? '',
  contractName: source.contractName ?? '',
  pol: source.pol,
  fd: source.fd,
  containerType: source.containerType,
  containerCount: source.containerCount,
})

/* ── CSV parsing ──────────────────────────────────────────────────────────
   Flexible header → column-index map (authored lowercase, matched case-insensitively). Rows are
   parsed positionally so the unnamed "ghost" carrier columns forwarders append are reachable.
   `forwarder` + `fd` are read when present (the PTP template carries them); the forwarder grid's
   own rate sheets lack those headers, so its behaviour is unchanged. */
export const CSV_FIELD_ALIASES = {
  forwarder: ['forwarder'],
  contract: ['contract', 'contract no', 'contract_no', 'contract number', 'contract #'],
  contractName: ['contract name', 'contractname', 'contract_name'],
  pol: ['pol', 'port of loading', 'port_of_loading'],
  fd: ['fd', 'final destination', 'final_destination'],
  pod: ['pod', 'port of discharge', 'port_of_discharge'],
  lastCy: ['last_cy', 'last cy', 'last cy/cfs', 'lastcy'],
  rate: ['rate', 'rate/unit', 'rate per unit', 'rate_amount'],
  freeDays: ['free_days', 'free days', '# of free days', 'freedays'],
  carrier: ['carrier'],
  validUntil: ['valid_until', 'valid until', 'validuntil'],
  remarks: ['remarks', 'notes'],
}

export const buildHeaderIndex = (headerCells) => {
  const normalized = headerCells.map((h) => String(h ?? '').trim().toLowerCase())
  const index = {}
  for (const [field, aliases] of Object.entries(CSV_FIELD_ALIASES)) {
    const at = normalized.findIndex((h) => h !== '' && aliases.includes(h))
    if (at !== -1) index[field] = at
  }
  return index
}

const cellAt = (cells, idx) => (idx == null ? '' : String(cells[idx] ?? '').trim())

export const makeRowFromCsv = (cells, headerIndex) => {
  const validRaw = cellAt(cells, headerIndex.validUntil)
  const valid = validRaw ? new Date(validRaw) : null

  // Carriers + trailing comments: scan from the Carrier column to the end of the row.
  const carriers = new Set()
  const remarkFragments = []
  if (headerIndex.carrier != null) {
    for (let i = headerIndex.carrier; i < cells.length; i++) {
      const val = String(cells[i] ?? '').trim()
      if (!val) continue
      const code = normalizeCarrier(val)
      if (CARRIER_CODES.has(code)) carriers.add(code)
      else remarkFragments.push(val)
    }
  }

  const remarks = [cellAt(cells, headerIndex.remarks), ...remarkFragments].filter(Boolean).join('; ')

  return {
    id: `new-${nextTempId++}`,
    laneId: null,
    period: null,
    forwarderName: cellAt(cells, headerIndex.forwarder), // raw; resolved → id at submit
    contract: cellAt(cells, headerIndex.contract),       // internal only; blank for most rates
    contractName: cellAt(cells, headerIndex.contractName), // internal only; pairs with contract
    fd: cellAt(cells, headerIndex.fd),
    containerType: '',
    containerCount: '',
    pol: cellAt(cells, headerIndex.pol),
    pod: cellAt(cells, headerIndex.pod),
    lastCy: cellAt(cells, headerIndex.lastCy),
    rate: cellAt(cells, headerIndex.rate),
    freeDays: cellAt(cells, headerIndex.freeDays),
    carrier: [...carriers],
    validUntil: valid && !isNaN(valid.getTime()) ? valid : null,
    remarks,
  }
}

export const isBlankRow = (r) =>
  !r.laneId && !r.pol && r.rate === '' && !r.pod && !r.lastCy && r.carrier.length === 0 && !r.remarks

/* ── shared DataGrid styling ──────────────────────────────────────────────────
   MUI is styled through `sx`, not Tailwind, so it cannot inherit the theme the way the rest of
   the app does. Every value here therefore reads the SAME skin variables tailwind.config.js
   maps its utilities onto — otherwise the grids, which are the densest and most-looked-at
   surface in this app, would keep the old palette while everything around them changed.

   Alpha is expressed as `rgb(var(--x) / 0.5)` rather than a baked rgba(), so a skin swap
   carries the focus ring with it. */
export const DATA_GRID_SX = {
  border: 'none',
  fontFamily: 'var(--font-sans)',
  '& .MuiDataGrid-columnHeaders': {
    backgroundColor: 'rgb(var(--c-fog-50))',
    borderBottom: '1px solid rgb(var(--c-fog-200))',
  },
  '& .MuiDataGrid-columnHeader': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.62rem',
    fontWeight: 600,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    color: 'rgb(var(--c-fog-600))',
    padding: '0 8px',
  },
  '& .MuiDataGrid-columnSeparator': { color: 'rgb(var(--c-fog-100))' },
  '& .MuiDataGrid-cell': {
    fontSize: '0.8rem',
    color: 'rgb(var(--c-harbor-900))',
    borderColor: 'rgb(var(--c-fog-100))',
    padding: '0 8px',
  },
  '& .MuiDataGrid-row:hover': { backgroundColor: 'rgb(var(--c-fog-50))' },
  '& .MuiDataGrid-cell:focus, & .MuiDataGrid-cell:focus-within': {
    outline: '2px solid rgb(var(--c-signal-500) / 0.5)',
    outlineOffset: '-2px',
  },
  '& .MuiDataGrid-cell--editing': {
    boxShadow: 'inset 0 0 0 2px rgb(var(--c-signal-500) / 0.5)',
  },
}

/* Grid height that fits the rows but caps at `cap` (default 70vh) so the body scrolls — and MUI
   keeps the column headers pinned — once there are more rows than fit. Use instead of autoHeight
   so few-row grids stay compact while long ones get a frozen header. (Defaults: 52px rows / 56px
   header, MUI X defaults.) */
export const gridScrollHeight = (rowCount, { cap = '70vh', rowH = 52, headerH = 56 } = {}) =>
  `min(${headerH + rowCount * rowH + 2}px, ${cap})`

/* ── shared toast ─────────────────────────────────────────────────────────── */
const TOAST_COLORS = {
  success: 'bg-sea-600',
  warning: 'bg-signal-600',
  error:   'bg-red-600',
}

export function Toast({ toast, onClose }) {
  if (!toast) return null
  return (
    <div className={`fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-card-hover animate-rise-in ${TOAST_COLORS[toast.severity]}`}>
      <span>{toast.message}</span>
      {toast.action && (
        <button
          className="rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide underline-offset-2 transition-colors hover:bg-white/20"
          onClick={() => { toast.action.onClick(); onClose() }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        className="rounded-md p-0.5 transition-colors hover:bg-white/20"
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  )
}
