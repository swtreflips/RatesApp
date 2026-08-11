import React from 'react'

/*
  Drayage grid building blocks — row factories, column defs, and the CSV header map for the
  drayage template (drayTemplate.csv / DRAY.md §6a). Shared by the forwarder Submit page and
  the internal Upload page (which adds a Forwarder picker column).

  Row shape (client-side field names → DB columns via drayageService.buildRate):
    forwarderName (internal Upload only; resolved to an id at submit) · origin (Last CY/CFS) ·
    destination (Final Destination) · zip · rate · fuelPct · fuelAmount · tollFee · prePullFee ·
    pierPassFee · cleanTruckFee · dropFee · chassisFee · chassisSplitFee · minChassisDays ·
    chassisDaysIncluded · portCongestionFee · demurrageFee · storagePerDay ·
    notes (+ laneId when answering a request).
*/

let tempId = 0
const nextId = () => `dray-tmp-${++tempId}`

export const makeDrayEmptyRow = () => ({
  id: nextId(),
  laneId: null,
  origin: '', destination: '', zip: '',
  rate: '', fuelPct: '', fuelAmount: '',
  tollFee: '', prePullFee: '', pierPassFee: '', cleanTruckFee: '', dropFee: '',
  chassisFee: '', chassisSplitFee: '', minChassisDays: '', chassisDaysIncluded: '',
  portCongestionFee: '', demurrageFee: '', storagePerDay: '',
  providedAt: null,  // Date Received — blank means "let the DB default to today" (drayageService)
  notes: '',
  forwarderName: '', // internal "Upload Drayage Rates" only; resolved to an id at submit
})

/** Seed a grid row from an open request lane — the lane's routing is the guide. */
export const makeDrayRowFromLane = (lane) => ({
  ...makeDrayEmptyRow(),
  id: lane.id,          // primary lane row: id === laneId (same convention as ocean)
  laneId: lane.id,
  origin: lane.last_cy_cfs ?? '',
  destination: lane.final_destination ?? '',
  zip: lane.dest_zip ?? '',
  kind: lane.kind,
  requestNotes: lane.notes ?? '',
})

export const makeDrayCopyRow = (source) => ({
  ...source,
  id: nextId(),
  laneId: source.laneId, // a copy still answers the same lane
})

export const isDrayBlankRow = (r) =>
  !r.origin && !r.destination && (r.rate === '' || r.rate == null)

/* ── CSV / XLSX header map (drayTemplate.csv §6a) ────────────────────── */

const DRAY_CSV_ALIASES = {
  forwarderName: ['forwarder', 'forwarder/carrier', 'forwarder name', 'carrier'],
  origin: ['last cy/cfs', 'last cy', 'origin'],
  destination: ['final destination', 'destination'],
  zip: ['zip code', 'zip'],
  rate: ['rate'],
  fuelPct: ['fuel surcharge %', 'fuel %', 'fuel pct'],
  fuelAmount: ['fuel surcharge'],
  tollFee: ['toll fee', 'toll'],
  prePullFee: ['pre-pull fee', 'pre pull fee', 'prepull fee'],
  pierPassFee: ['pier pass fee', 'pierpass fee'],
  cleanTruckFee: ['clean truck fee'],
  dropFee: ['drop fee'],
  chassisFee: ['chassis fee'],
  chassisSplitFee: ['chassis split fee', 'chassis split'],
  minChassisDays: ['min chassis days'],
  chassisDaysIncluded: ['chassis days included'],
  portCongestionFee: ['port congestion fee', 'port congestion'],
  demurrageFee: ['demurrage fee', 'demurrage'],
  storagePerDay: ['storage fee (/day)', 'storage fee/day', 'storage fee'],
  providedAt: ['date received', 'date recieved'],
  notes: ['notes', 'remarks'],
}

/** Header row → {field: columnIndex}. Matching is normalized (trim/lowercase). */
export const buildDrayHeaderIndex = (headerCells) => {
  const norm = headerCells.map((h) => String(h ?? '').trim().toLowerCase())
  const index = {}
  for (const [field, aliases] of Object.entries(DRAY_CSV_ALIASES)) {
    // exact alias match first (so 'fuel surcharge' never claims 'fuel surcharge %')
    const i = norm.findIndex((h) => aliases.includes(h))
    if (i !== -1) index[field] = i
  }
  return index
}

export const makeDrayRowFromCsv = (cells, headerIndex) => {
  const val = (field) => {
    const i = headerIndex[field]
    return i == null ? '' : String(cells[i] ?? '').trim()
  }
  // Date Received, if the file has it — blank/unparseable falls through to null, same as a
  // blank manual-entry cell, so the DB's default-to-today applies either way (drayageService).
  const receivedRaw = val('providedAt')
  const received = receivedRaw ? new Date(receivedRaw) : null
  return {
    ...makeDrayEmptyRow(),
    forwarderName: val('forwarderName'),
    origin: val('origin'),
    destination: val('destination'),
    zip: val('zip'),
    rate: val('rate'),
    fuelPct: val('fuelPct'),
    fuelAmount: val('fuelAmount'),
    tollFee: val('tollFee'),
    prePullFee: val('prePullFee'),
    pierPassFee: val('pierPassFee'),
    cleanTruckFee: val('cleanTruckFee'),
    dropFee: val('dropFee'),
    chassisFee: val('chassisFee'),
    chassisSplitFee: val('chassisSplitFee'),
    minChassisDays: val('minChassisDays'),
    chassisDaysIncluded: val('chassisDaysIncluded'),
    portCongestionFee: val('portCongestionFee'),
    demurrageFee: val('demurrageFee'),
    storagePerDay: val('storagePerDay'),
    providedAt: received && !isNaN(received.getTime()) ? received : null,
    notes: val('notes'),
  }
}

/* ── display helpers ─────────────────────────────────────────────────── */

/** Client-side preview of the DB's generated total (rate + resolved fuel). Display only. */
export function previewTotal(row) {
  const rate = Number(row.rate)
  if (!Number.isFinite(rate)) return null
  const amount = Number(row.fuelAmount)
  if (Number.isFinite(amount) && row.fuelAmount !== '') return rate + amount
  let pct = Number(row.fuelPct)
  if (Number.isFinite(pct) && row.fuelPct !== '') {
    if (pct > 1) pct = pct / 100 // forwarders type 34 for 34%
    return rate + Math.round(rate * pct * 100) / 100
  }
  return rate
}

/* Shared display formatters — used by the drayage grid, both drayage rate pages, and Bookings.
   Hoisted here (next to StalenessBadge) so there's one definition, not a copy per page. */
export const money = (v) => (v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
export const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(2)}%`)
export { fmtDate } from '../../lib/dates'   // DATE columns must not round-trip through UTC

const numCol = (field, headerName, width = 92) => ({
  field, headerName, width, editable: true, type: 'number', cellClassName: 'font-mono',
})

/**
 * Column defs for the drayage entry grid. `renderActions(params)` supplies the trailing
 * action cell; `extraLeading` (e.g. the internal Forwarder picker) is prepended.
 */
export function drayColumns({ renderActions, extraLeading = [] }) {
  return [
    {
      field: 'rowNum', headerName: '#', width: 38, sortable: false, filterable: false,
      cellClassName: 'font-mono text-fog-400',
      renderCell: (params) => params.api.getRowIndexRelativeToVisibleRows(params.row.id) + 1,
    },
    ...extraLeading,
    { field: 'origin', headerName: 'Last CY/CFS', flex: 1.1, minWidth: 120, editable: true },
    { field: 'destination', headerName: 'Final Destination', flex: 1.1, minWidth: 120, editable: true },
    { field: 'zip', headerName: 'Zip', width: 72, editable: true, cellClassName: 'font-mono' },
    numCol('rate', 'Rate', 84),
    numCol('fuelPct', 'Fuel %', 74),
    numCol('fuelAmount', 'Fuel $', 78),
    {
      field: 'total', headerName: 'Total', width: 92, sortable: false, filterable: false,
      cellClassName: 'font-mono font-semibold',
      renderCell: (params) => money(previewTotal(params.row)),
    },
    numCol('tollFee', 'Toll', 70),
    numCol('prePullFee', 'Pre-pull', 78),
    numCol('pierPassFee', 'Pier Pass', 82),
    numCol('portCongestionFee', 'Port Congestion', 108),
    numCol('cleanTruckFee', 'Clean Truck', 92),
    numCol('dropFee', 'Drop', 68),
    numCol('chassisFee', 'Chassis', 78),
    numCol('chassisSplitFee', 'Chassis Split', 96),
    numCol('minChassisDays', 'Min Ch. Days', 96),
    numCol('chassisDaysIncluded', 'Ch. Days Incl', 96),
    numCol('demurrageFee', 'Demurrage', 88),
    numCol('storagePerDay', 'Storage/Day', 94),
    {
      field: 'providedAt', headerName: 'Date Received', width: 108, editable: true, type: 'date',
    },
    { field: 'notes', headerName: 'Notes', flex: 1, minWidth: 100, editable: true },
    {
      field: 'actions', headerName: '', width: 72, sortable: false, filterable: false,
      renderCell: renderActions,
    },
  ]
}

/* ── staleness badge (§6b) ───────────────────────────────────────────── */

const STALENESS_STYLES = {
  fresh: 'bg-sea-50 text-sea-700 ring-sea-200',
  aging: 'bg-signal-50 text-signal-700 ring-signal-200',
  stale: 'bg-red-50 text-red-600 ring-red-200',
}

export function StalenessBadge({ level }) {
  if (!level) return null
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] ring-1 ring-inset ${STALENESS_STYLES[level]}`}>
      {level}
    </span>
  )
}
