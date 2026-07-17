/*
  Drayage template fill (DRAY.md §6a) — same XML-surgery technique as fillTemplate.ts
  (cell values only; every other zip entry untouched) against the drayage template.

  Column map (1-based, sheet1 — mirrors drayTemplate.csv):
    A(1) Last CY/CFS · B(2) Final Destination · C(3) Drayage Lane (origin - destination) ·
    D(4) Zip Code · S(19) Notes.
  The requester fills the routing; the money columns (E–R) stay blank for the forwarder.
  Data rows start at row 2.
*/

import { unzipSync, zipSync, strToU8, strFromU8 } from 'npm:fflate@0.8.2'

export type DrayFillLane = {
  last_cy_cfs?: string | null
  final_destination?: string | null
  dest_zip?: string | null
  notes?: string | null
}

const SHEET1 = 'xl/worksheets/sheet1.xml'
const DATA_START_ROW = 2

const COL_ORIGIN = 1
const COL_DESTINATION = 2
const COL_LANE = 3
const COL_ZIP = 4
const COL_NOTES = 19

function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function textCell(col: number, row: number, value: string): string {
  return `<c r="${colLetter(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

function nonEmpty(v: unknown): v is string {
  return v !== null && v !== undefined && String(v).trim() !== ''
}

function buildRow(lane: DrayFillLane, rowNum: number): string {
  const cells: Array<{ col: number; xml: string }> = []
  const push = (col: number, v: unknown) => {
    if (nonEmpty(v)) cells.push({ col, xml: textCell(col, rowNum, String(v).trim()) })
  }

  push(COL_ORIGIN, lane.last_cy_cfs)
  push(COL_DESTINATION, lane.final_destination)
  if (nonEmpty(lane.last_cy_cfs) && nonEmpty(lane.final_destination)) {
    push(COL_LANE, `${String(lane.last_cy_cfs).trim()} - ${String(lane.final_destination).trim()}`)
  }
  push(COL_ZIP, lane.dest_zip)
  push(COL_NOTES, lane.notes)

  cells.sort((a, b) => a.col - b.col)
  if (cells.length === 0) return `<row r="${rowNum}"/>`
  const spans = `${cells[0].col}:${cells[cells.length - 1].col}`
  return `<row r="${rowNum}" spans="${spans}">${cells.map((c) => c.xml).join('')}</row>`
}

/** Fill the drayage template with `lanes` and return the .xlsx bytes. */
export function fillDrayageTemplate(templateBytes: Uint8Array, lanes: DrayFillLane[]): Uint8Array {
  const files = unzipSync(templateBytes)
  const sheetEntry = files[SHEET1]
  if (!sheetEntry) throw new Error(`Template missing ${SHEET1}`)

  const xml = strFromU8(sheetEntry)
  const openMatch = xml.match(/<sheetData(?:\s[^>]*)?>/)
  const closeIdx = xml.indexOf('</sheetData>')
  if (!openMatch || closeIdx === -1) {
    throw new Error('Could not locate <sheetData> in sheet1.xml')
  }
  const openTag = openMatch[0]
  const inner = xml.slice(openMatch.index! + openTag.length, closeIdx)
  const headerRow = inner.match(/<row\s+r="1"[\s\S]*?<\/row>/)?.[0] ?? ''

  const dataRows = lanes.map((lane, i) => buildRow(lane, DATA_START_ROW + i)).join('')
  const newSheetData = `${openTag}${headerRow}${dataRows}</sheetData>`
  const newXml = xml.slice(0, openMatch.index!) + newSheetData + xml.slice(closeIdx + '</sheetData>'.length)

  files[SHEET1] = strToU8(newXml)
  return zipSync(files)
}
