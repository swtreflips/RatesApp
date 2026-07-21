/*
  Bookings — parse the AIS OFQ file (ratesInput.csv shape) into OFQs that KEEP their full applied
  ocean rate rows. This is the difference from Apply Rates' groupByOfq(), which only keeps a hashed
  dedup key per OFRID row (enough to skip duplicates, not enough to display an option). Bookings
  needs the whole row, so it has its own grouping — but reuses Apply Rates' header detection, which
  already untangles the file's DUPLICATE "Port of Loading" header (OFQ's POL vs. the rate's POL).
*/

import { buildApplyHeaderIndex } from '../../internal/applyRates/inputCsv'
import { norm } from './matching'

const cell = (cells, i) => (i != null && i >= 0 ? String(cells[i] ?? '').trim() : '')

// buildApplyHeaderIndex covers the shared columns but not container / cargo-ready info —
// detect those here (they exist in the OFQ file; Apply Rates just never needed them).
function extraCols(headerCells) {
  const headers = headerCells.map((h) => norm(h))
  return {
    containerType: headers.indexOf('container type'),
    containerCount: headers.indexOf('# of containers'),
    cargoReadyDate: headers.indexOf('cargo ready date'),
  }
}

/** Reuses Apply Rates' index (+ its `missing` check on OFQID/POL/FD), plus the extra columns. */
export function buildBookingsHeaderIndex(headerCells) {
  const { index, missing } = buildApplyHeaderIndex(headerCells)
  return { index: { ...index, ...extraCols(headerCells) }, missing }
}

/**
 * One Ofq per OFQID; each OFRID row (a rate already applied to that OFQ) becomes a selectable
 * OceanOption with its full identity. First row's POL/FD/container win.
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
