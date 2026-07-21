/*
  Bookings — parse the AIS "OFR universe" export (OFRUniverseExample.csv shape) into OFQs that
  KEEP their full applied ocean rate rows (one OceanOption per OFRID row).

  WHY THIS DOESN'T REUSE buildApplyHeaderIndex: the universe export carries TWO column blocks —
  an OFQ-side block that ALSO contains `Rate/Unit`, `Port of Discharge`, `Last CY/CFS`, `Carrier`
  (all blank in the export), and then the OFR block with the real values. A plain
  `headers.indexOf(...)` (Apply Rates' approach — fine for its input shape) binds to the EMPTY
  first-block columns, which surfaced as "OFRs with no rate". The rule here: every OFR-block
  column is resolved AT/AFTER the OFRID column's position. This also handles the simpler
  ratesInput.csv shape unchanged (there, OFRID precedes those columns anyway).

  Ocean data comes ONLY from this file — never the DB. Drayage comes ONLY from the DB
  (drayage_rates via the page's fetch-once index). BOOKINGS.md §2.
*/

import { norm } from './matching'

const cell = (cells, i) => (i != null && i >= 0 ? String(cells[i] ?? '').trim() : '')

/** First index of `name` at or after `from`; -1 when absent. */
const idxFrom = (headers, name, from = 0) => {
  for (let i = Math.max(0, from); i < headers.length; i++) {
    if (headers[i] === name) return i
  }
  return -1
}

/**
 * Header row → column index, block-aware (see file comment). `missing` names the
 * required OFQ-side columns so the upload can fail with a precise message.
 */
export function buildBookingsHeaderIndex(headerCells) {
  const headers = headerCells.map((h) => norm(h))
  const ofrId = headers.indexOf('ofrid')
  // The OFR block starts at OFRID; with no OFRID column the whole row is OFQ-side
  // and the OFR lookups below all resolve to -1 (→ no ocean options, handled downstream).
  const ofrFrom = ofrId === -1 ? headers.length : ofrId

  const ratePol = idxFrom(headers, 'port of loading', ofrFrom)

  const index = {
    // ── OFQ block: first occurrences (always before the OFR block) ──
    ofqId: headers.indexOf('ofqid'),
    ofqPol: headers.indexOf('port of loading'),
    fd: headers.indexOf('final destination'),
    cargoReadyDate: headers.indexOf('cargo ready date'),
    containerType: headers.indexOf('container type'),
    containerCount: headers.indexOf('# of containers'),
    // ── OFR block: resolved at/after the OFRID column ──
    ofrId,
    forwarder: idxFrom(headers, 'forwarder/carrier', ofrFrom),
    rate: idxFrom(headers, 'rate/unit', ofrFrom),
    // single-POL files have no second POL column → the OFR shares the OFQ's
    ratePol: ratePol !== -1 ? ratePol : headers.indexOf('port of loading'),
    pod: idxFrom(headers, 'port of discharge', ofrFrom),
    lastCy: idxFrom(headers, 'last cy/cfs', ofrFrom),
    validUntil: idxFrom(headers, 'valid until', ofrFrom),
    carrier: idxFrom(headers, 'carrier', ofrFrom),
  }

  const missing = []
  if (index.ofqId === -1) missing.push('OFQID')
  if (index.ofqPol === -1) missing.push('Port of Loading')
  if (index.fd === -1) missing.push('Final Destination')
  return { index, missing }
}

/**
 * One Ofq per OFQID; each OFRID row (an ocean rate applied to that OFQ) becomes a selectable
 * OceanOption with its full identity. First row's POL/FD/container/cargo-ready win.
 *
 * @returns {{ ofqId, pol, fd, cargoReadyDate, containerType, containerCount, oceanOptions: OceanOption[] }[]}
 */
export function groupByOfqWithOptions(dataRows, index) {
  const map = new Map()
  for (const cells of dataRows) {
    const ofqId = cell(cells, index.ofqId)
    if (!ofqId) continue

    let ofq = map.get(ofqId)
    if (!ofq) {
      ofq = {
        ofqId,
        pol: cell(cells, index.ofqPol),
        fd: cell(cells, index.fd),
        cargoReadyDate: cell(cells, index.cargoReadyDate),
        containerType: cell(cells, index.containerType),
        containerCount: cell(cells, index.containerCount),
        oceanOptions: [],
      }
      map.set(ofqId, ofq)
    }

    if (cell(cells, index.ofrId)) {
      ofq.oceanOptions.push({
        ofrId: cell(cells, index.ofrId),
        forwarder: cell(cells, index.forwarder),
        pol: cell(cells, index.ratePol),
        pod: cell(cells, index.pod),
        lastCy: cell(cells, index.lastCy),
        carrier: cell(cells, index.carrier),
        rate: cell(cells, index.rate),
        validUntil: cell(cells, index.validUntil),
      })
    }
  }
  return [...map.values()]
}
