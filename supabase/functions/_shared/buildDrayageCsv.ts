/*
  Outbound DRAYAGE template (DRAY.md §6a) — a plain CSV.

  WHY NOT XLSX, when ocean does XML surgery: ocean's surgery exists for exactly one reason, stated
  in fillTemplate.ts — its POD / Last CY / Carrier dropdowns are x14 "extension-list" data
  validations, which ExcelJS and openpyxl silently drop on re-save, so the file has to be edited
  in place rather than regenerated. The drayage template has NO dropdowns, no data validations and
  no Validation sheet; it is one flat sheet of 19 headers. There was nothing for a round trip to
  protect, so the xlsx cost a 13 KB embedded blob and a zip/XML rewrite to deliver what a comma
  does. The return path is unaffected — DrayageUploadRates already accepts .csv.

  Columns mirror drayTemplate.csv exactly and in order, because that file is what the forwarder
  fills in and hands back to `parseRateFile`. The requester prefills the routing; every money
  column stays blank.

  Prefilled: A Last CY/CFS · B Final Destination · C Drayage Lane · D Zip Code · S Notes.
*/

/** The 19 columns of drayTemplate.csv, in order. Header row of every file we send. */
export const DRAYAGE_HEADERS = [
  'Last CY/CFS',
  'Final Destination',
  'Drayage Lane',
  'Zip Code',
  'Rate',
  'Fuel Surcharge %',
  'Fuel Surcharge',
  'Total Rate',
  'Toll Fee',
  'Pre-pull Fee',
  'Pier Pass Fee',
  'Clean Truck Fee',
  'Drop Fee',
  'Chassis Fee',
  'Min Chassis Days',
  'Chassis Days Included',
  'Storage Fee (/Day)',
  'Date Received',
  'Notes',
] as const

export type DrayCsvLane = {
  last_cy_cfs?: string | null
  final_destination?: string | null
  dest_zip?: string | null
  notes?: string | null
}

// 0-based positions of the columns the requester fills.
const COL_ORIGIN = 0
const COL_DESTINATION = 1
const COL_LANE = 2
const COL_ZIP = 3
const COL_NOTES = 18

/**
 * RFC 4180 quoting.
 *
 * NOT optional here: every location in this file reads "Los Angeles, CA", so an unquoted value
 * would split into two fields and shift the whole row left — silently, and in the forwarder's
 * copy rather than ours.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value).trim()
  if (s === '') return ''
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const nonEmpty = (v: unknown): v is string =>
  v !== null && v !== undefined && String(v).trim() !== ''

function buildRow(lane: DrayCsvLane): string {
  const cells = new Array<string>(DRAYAGE_HEADERS.length).fill('')
  cells[COL_ORIGIN] = csvField(lane.last_cy_cfs)
  cells[COL_DESTINATION] = csvField(lane.final_destination)
  // Only when both sides exist — "Los Angeles, CA - " is worse than blank.
  if (nonEmpty(lane.last_cy_cfs) && nonEmpty(lane.final_destination)) {
    cells[COL_LANE] = csvField(
      `${String(lane.last_cy_cfs).trim()} - ${String(lane.final_destination).trim()}`,
    )
  }
  cells[COL_ZIP] = csvField(lane.dest_zip)
  cells[COL_NOTES] = csvField(lane.notes)
  return cells.join(',')
}

/**
 * Build the drayage rate request CSV for `lanes`.
 *
 * CRLF and a UTF-8 BOM: Excel opens a BOM-less UTF-8 CSV in the system codepage, which turns any
 * non-ASCII company or city name into mojibake, and it is the difference between a table and one
 * mangled column. Returns bytes so the call site stays a drop-in for the old xlsx fill.
 */
export function buildDrayageCsv(lanes: DrayCsvLane[]): Uint8Array {
  const lines = [DRAYAGE_HEADERS.map(csvField).join(','), ...lanes.map(buildRow)]
  const text = `﻿${lines.join('\r\n')}\r\n`
  return new TextEncoder().encode(text)
}
