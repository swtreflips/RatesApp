/*
  Outbound template fill (ALERTS.md §6a) — the cloud/TS counterpart of graph.py's
  fill_template(). Writes the requester columns for each lane into a copy of
  `PTP OFQ Rates Template.xlsx`, leaving the forwarder columns (J,K,O–S) and the deferred
  request fields (A,B,E,F,G) blank, and returns the new .xlsx bytes.

  WHY XML SURGERY (not ExcelJS): the template's POD / Last CY / Carrier dropdowns are x14
  "extension-list" data validations, which ExcelJS (and openpyxl) drop on re-save. We touch
  ONLY the cell values inside xl/worksheets/sheet1.xml and leave every other zip entry
  (styles.xml, the extLst dropdowns, the Validation sheet, sharedStrings.xml) byte-for-byte
  untouched — so styling and dropdowns survive 100%. The dropdown sqref ranges are
  column-wide (e.g. M1:M1048576), so plain value cells inherit the dropdown for free.

  Data goes in as INLINE strings (t="inlineStr"), so sharedStrings.xml is never modified.

  Column map (1-based, Sheet1) — mirrors graph.py so the two stay in lockstep:
    C(3) Port of Loading · D(4) Final Destination · H(8) Container Type ·
    I(9) # of Containers · L(12) Forwarder · M(13) Port of Discharge · N(14) Last CY/CFS.
  Data rows start at row 2.
*/

import { unzipSync, zipSync, strToU8, strFromU8 } from 'npm:fflate@0.8.2'

export type FillLane = {
  pol?: string | null
  fd?: string | null
  container_type?: string | null
  container_count?: number | string | null
  pod?: string | null
  last_cy?: string | null
}

const SHEET1 = 'xl/worksheets/sheet1.xml'
const DATA_START_ROW = 2

// 1-based column numbers (graph.py parity)
const COL_POL = 3
const COL_FD = 4
const COL_CONTAINER_TYPE = 8
const COL_CONTAINER_COUNT = 9
const COL_FORWARDER = 12
const COL_POD = 13
const COL_LAST_CY = 14

/** 1-based column number → spreadsheet letter (3 → "C", 27 → "AA"). */
export function colLetter(n: number): string {
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

/** An inline-string cell: <c r="C2" t="inlineStr"><is><t xml:space="preserve">…</t></is></c> */
function textCell(col: number, row: number, value: string): string {
  return `<c r="${colLetter(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

/** A numeric cell: <c r="I2"><v>3</v></c> */
function numCell(col: number, row: number, value: number): string {
  return `<c r="${colLetter(col)}${row}"><v>${value}</v></c>`
}

function nonEmpty(v: unknown): v is string | number {
  return v !== null && v !== undefined && String(v).trim() !== ''
}

/** Build one <row> for a lane. Cells are emitted in ascending column order. */
function buildRow(lane: FillLane, rowNum: number, forwarderName: string): string {
  const cells: Array<{ col: number; xml: string }> = []
  const pushText = (col: number, v: unknown) => {
    if (nonEmpty(v)) cells.push({ col, xml: textCell(col, rowNum, String(v).trim()) })
  }

  pushText(COL_POL, lane.pol)
  pushText(COL_FD, lane.fd)
  pushText(COL_CONTAINER_TYPE, lane.container_type)

  // # of Containers — numeric when it parses, else inline string (defensive)
  if (nonEmpty(lane.container_count)) {
    const n = Number(lane.container_count)
    cells.push({
      col: COL_CONTAINER_COUNT,
      xml: Number.isFinite(n)
        ? numCell(COL_CONTAINER_COUNT, rowNum, n)
        : textCell(COL_CONTAINER_COUNT, rowNum, String(lane.container_count).trim()),
    })
  }

  // Forwarder (L) — always stamped (attribution convenience, ALERTS.md §6a)
  pushText(COL_FORWARDER, forwarderName)

  // POD / Last CY — only when the requester pre-set them; else blank for the forwarder to fill
  pushText(COL_POD, lane.pod)
  pushText(COL_LAST_CY, lane.last_cy)

  cells.sort((a, b) => a.col - b.col)
  if (cells.length === 0) return `<row r="${rowNum}"/>`
  const spans = `${cells[0].col}:${cells[cells.length - 1].col}`
  return `<row r="${rowNum}" spans="${spans}">${cells.map((c) => c.xml).join('')}</row>`
}

/**
 * Fill the bundled template with `lanes` for one forwarder and return the .xlsx bytes.
 * Pure: does not read the filesystem — the caller passes the template bytes in.
 */
export function fillTemplate(
  templateBytes: Uint8Array,
  lanes: FillLane[],
  forwarderName: string,
): Uint8Array {
  const files = unzipSync(templateBytes)
  const sheetEntry = files[SHEET1]
  if (!sheetEntry) throw new Error(`Template missing ${SHEET1}`)

  const xml = strFromU8(sheetEntry)

  // Locate the <sheetData …> … </sheetData> block.
  const openMatch = xml.match(/<sheetData(?:\s[^>]*)?>/)
  const closeIdx = xml.indexOf('</sheetData>')
  if (!openMatch || closeIdx === -1) {
    throw new Error('Could not locate <sheetData> in sheet1.xml')
  }
  const openTag = openMatch[0]
  const innerStart = openMatch.index! + openTag.length
  const inner = xml.slice(innerStart, closeIdx)

  // Keep the header row (r="1"); drop every existing data row (r>=2, including stray styled
  // empty rows) so the data region is clean regardless of lane count.
  const headerRow = inner.match(/<row\s+r="1"[\s\S]*?<\/row>/)?.[0] ?? ''

  const dataRows = lanes
    .map((lane, i) => buildRow(lane, DATA_START_ROW + i, forwarderName))
    .join('')

  const newSheetData = `${openTag}${headerRow}${dataRows}</sheetData>`
  const newXml = xml.slice(0, openMatch.index!) + newSheetData + xml.slice(closeIdx + '</sheetData>'.length)

  files[SHEET1] = strToU8(newXml)
  return zipSync(files)
}
