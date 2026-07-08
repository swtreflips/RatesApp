/*
  Apply Rates — parse the AIS "rates input" file (ratesInput.csv shape) into OFQ groups.

  The file has a DUPLICATE "Port of Loading" header: the 1st occurrence is the OFQ's POL,
  the 2nd is the applied rate's POL. That forces positional parsing (parseRateFile already
  runs papaparse with header:false — header:true would silently clobber the duplicate).

  Rows with an OFRID describe a rate ALREADY applied to that OFQ; their rate fields are
  hashed into appliedKeys so the matcher can skip re-applying identical rates.
*/

import { norm, rateKey, laneKeyOf } from './matcher'

export function buildApplyHeaderIndex(headerCells) {
  const headers = headerCells.map((h) => norm(h))
  const polIdxs = headers.reduce((acc, h, i) => (h === 'port of loading' ? [...acc, i] : acc), [])
  const idx = (name) => headers.indexOf(name) // exact match: 'carrier' ≠ 'forwarder/carrier'

  const index = {
    ofqId: idx('ofqid'),
    ofqPol: polIdxs[0] ?? -1,
    fd: idx('final destination'),
    ofrId: idx('ofrid'),
    forwarder: idx('forwarder/carrier'),
    rate: idx('rate/unit'),
    ratePol: polIdxs[1] ?? polIdxs[0] ?? -1, // single-POL files: reuse the OFQ POL
    pod: idx('port of discharge'),
    lastCy: idx('last cy/cfs'),
    validUntil: idx('valid until'),
    carrier: idx('carrier'),
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
