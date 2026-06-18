/*
  Shared rate-entry grid building blocks — used by the forwarder "Submit Rates" page and the
  internal "Upload Rates" page. Pure, role-agnostic logic + the styled DataGrid sx + the Toast.
  Each page keeps its own columns + handlers (skip vs plain delete, lane preload source, the
  Forwarder column) and composes these primitives.

  A row's shape: lane guides (fd/containerType/containerCount), rate fields
  (pol/pod/lastCy/rate/freeDays/carrier[]/validUntil/remarks), laneId/period for grouping, and
  `forwarderId` (used only by the internal grid; ignored by the forwarder grid).
*/

import React from 'react'
import { X } from 'lucide-react'
import Papa from 'papaparse'

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

/* ── row factories ────────────────────────────────────────────────────────
   Temp ids are string-prefixed so they never collide with a lane's uuid id. */
let nextTempId = 1

export const makeEmptyRow = () => ({
  id: `new-${nextTempId++}`,
  laneId: null,
  period: null,
  forwarderName: '',        // internal "Upload Rates" only; the forwarder grid ignores it
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

/* ── shared DataGrid styling ──────────────────────────────────────────────── */
export const DATA_GRID_SX = {
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
}

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
