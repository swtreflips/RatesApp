/*
  Apply Rates — parse the AIS "rates input" file (ratesInput.csv shape) into OFQ groups.

  The file is an OFR SEED: every OFQ appears, and an OFQ that already has rates applied
  repeats once per applied rate, carrying that rate's OFRID and its columns. An OFQ with
  nothing applied appears once with a blank OFRID. Rates are uploaded in waves, so this is
  what stops each wave re-applying everything the previous one already did.

  FIVE headers are duplicated between the OFQ block and the applied-rate block — Port of
  Loading, Port of Discharge, Last CY/CFS, Rate/Unit, Carrier. That forces positional parsing
  (parseRateFile already runs papaparse with header:false — header:true would silently clobber
  duplicates), and it is why buildApplyHeaderIndex resolves the second block relative to OFRID.

  Rows with an OFRID hash their rate fields into appliedKeys, which outputCsv subtracts per OFQ.
*/

import { norm, rateKey, laneKeyOf } from './matcher'

export function buildApplyHeaderIndex(headerCells) {
  const headers = headerCells.map((h) => norm(h))
  const occurrences = (name) => headers.reduce((acc, h, i) => (h === name ? [...acc, i] : acc), [])
  const idx = (name) => headers.indexOf(name) // exact match: 'carrier' ≠ 'forwarder/carrier'

  /*
    FIVE headers repeat, not one.

    The file is two blocks side by side: the OFQ's own columns, then — to the right of OFRID —
    the columns of a rate ALREADY applied to it. The second block repeats `Port of Loading`,
    `Port of Discharge`, `Last CY/CFS`, `Rate/Unit` and `Carrier` verbatim.

    `indexOf` returns the FIRST match, which is the OFQ-level column — and on an OFR row those
    cells are blank. Only Port of Loading was being resolved positionally, so the applied-rate
    key was built as `forwarder|pol|||||validUntil` and could never equal a real rate's key.
    The already-applied skip therefore never skipped anything, and every wave of uploads
    re-applied every rate the OFQ already had.

    OFRID is the boundary: the applied rate's columns are the first occurrence to its right.
    Files with a single block (no OFRID, or one Port of Loading) fall back to the only column
    there is, which is what the previous `polIdxs[1] ?? polIdxs[0]` did for POL alone.
  */
  const ofrId = idx('ofrid')
  const rateSide = (name) => {
    const found = occurrences(name)
    if (found.length === 0) return -1
    if (ofrId >= 0) {
      const after = found.find((i) => i > ofrId)
      if (after !== undefined) return after
    }
    return found[found.length - 1]
  }

  const index = {
    ofqId: idx('ofqid'),
    ofqPol: occurrences('port of loading')[0] ?? -1,
    fd: idx('final destination'),
    ofrId,
    forwarder: idx('forwarder/carrier'), // unique header — no OFQ-level twin
    rate: rateSide('rate/unit'),
    ratePol: rateSide('port of loading'),
    pod: rateSide('port of discharge'),
    lastCy: rateSide('last cy/cfs'),
    validUntil: rateSide('valid until'),
    carrier: rateSide('carrier'),
  }

  const missing = []
  if (index.ofqId === -1) missing.push('OFQID')
  if (index.ofqPol === -1) missing.push('Port of Loading')
  if (index.fd === -1) missing.push('Final Destination')
  return { index, missing }
}

const cell = (cells, i) => (i >= 0 ? String(cells[i] ?? '').trim() : '')

// Positional data rows → { ofqs, warnings }. One OFQ per unique OFQID; the first row's
// POL/Final Destination win, later disagreements are warned about.
export function groupByOfq(dataRows, index) {
  const map = new Map()
  const warned = new Set()
  const warnings = []

  for (const cells of dataRows) {
    const ofqId = cell(cells, index.ofqId)
    if (!ofqId) continue

    const pol = cell(cells, index.ofqPol)
    const fd = cell(cells, index.fd)
    let ofq = map.get(ofqId)
    if (!ofq) {
      ofq = { ofqId, pol, fd, appliedKeys: new Set(), appliedCount: 0, rowCount: 0 }
      map.set(ofqId, ofq)
    } else if (!warned.has(ofqId) && ((pol && norm(pol) !== norm(ofq.pol)) || (fd && norm(fd) !== norm(ofq.fd)))) {
      warned.add(ofqId)
      warnings.push(`${ofqId}: rows disagree on POL / Final Destination — using the first row's values`)
    }

    ofq.rowCount += 1
    if (cell(cells, index.ofrId)) {
      ofq.appliedCount += 1
      ofq.appliedKeys.add(rateKey({
        forwarder: cell(cells, index.forwarder),
        pol: cell(cells, index.ratePol),
        pod: cell(cells, index.pod),
        lastCy: cell(cells, index.lastCy),
        carrier: cell(cells, index.carrier),
        rate: cell(cells, index.rate),
        validUntil: cell(cells, index.validUntil),
      }))
    }
  }

  return { ofqs: [...map.values()], warnings }
}

// Unique (POL, Final Destination) lanes across the parsed OFQs — the matching unit.
// First OFQ's display labels win (consistent with groupByOfq's first-row-wins rule).
export function deriveLanes(ofqs) {
  const map = new Map()
  for (const o of ofqs) {
    const key = laneKeyOf(o.pol, o.fd)
    let lane = map.get(key)
    if (!lane) {
      lane = { laneKey: key, pol: o.pol, fd: o.fd, ofqIds: [] }
      map.set(key, lane)
    }
    lane.ofqIds.push(o.ofqId)
  }
  return [...map.values()]
}
