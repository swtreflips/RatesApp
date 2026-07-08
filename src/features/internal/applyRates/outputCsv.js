/*
  Apply Rates — build + download the output CSV in the AIS import template shape
  (ratesTemplate.csv). Header order is load-bearing: keep it byte-identical.
*/

import Papa from 'papaparse'
import { laneKeyOf, keyFromDbRate } from './matcher'

export const OUTPUT_HEADERS = [
  '# of Free Days', 'Carrier', 'Contract Number', 'Date Received', 'External ID',
  'Final Destination', 'Forwarder/Carrier', 'Last CY/CFS', 'Last CY/CFS ETA', 'Move',
  'Ocean Freight Quote', 'Port of Discharge', 'Port of Loading', 'Rate/Unit',
  'Shipping Mode', 'Valid Until', 'Vessel ETA', 'Vessel ETD',
]

const EMPTY_SET = new Set()

/*
  One output row per (OFQ, rate):
    ofqs        groupByOfq() output — each with appliedKeys (its OFRID rows)
    laneResults matchLane() results
    discarded   Map<laneKey, Set<cyNorm>> — yards the user removed in the review matrix

  Every deduped rate at every non-discarded qualified yard of the OFQ's lane, minus
  rates already applied to THAT OFQ. Pure + synchronous so the page can useMemo it
  for a live "rates to apply" count. Note: a yard chip's rate count is lane-level —
  an OFQ that already has some of those rates emits fewer rows than the chip shows.
  Unmapped columns stay blank; Move is fixed CY/CY; Valid Until passes through as stored.
*/
export function buildOutputRows(ofqs, laneResults, discarded) {
  const byLane = new Map(laneResults.map((r) => [r.laneKey, r]))
  const rows = []
  for (const ofq of ofqs) {
    const lane = byLane.get(laneKeyOf(ofq.pol, ofq.fd))
    if (!lane || lane.status !== 'matched') continue
    const dropped = discarded.get(lane.laneKey) ?? EMPTY_SET
    for (const yard of lane.qualified) {
      if (dropped.has(yard.cyNorm)) continue
      for (const r of yard.rates) {
        if (ofq.appliedKeys.has(keyFromDbRate(r))) continue
        rows.push([
          r.free_days ?? '',        // # of Free Days
          r.carrier ?? '',          // Carrier
          '',                       // Contract Number
          '',                       // Date Received
          '',                       // External ID
          ofq.fd ?? '',             // Final Destination (from the OFQ)
          r.forwarder?.name ?? '',  // Forwarder/Carrier
          r.last_cy ?? '',          // Last CY/CFS
          '',                       // Last CY/CFS ETA
          'CY/CY',                  // Move
          ofq.ofqId,                // Ocean Freight Quote
          r.pod ?? '',              // Port of Discharge
          r.pol ?? '',              // Port of Loading
          r.rate_amount ?? '',      // Rate/Unit
          '',                       // Shipping Mode
          r.valid_until ?? '',      // Valid Until
          '',                       // Vessel ETA
          '',                       // Vessel ETD
        ])
      }
    }
  }
  return rows
}

export function downloadCsv(rows, filename) {
  const csv = Papa.unparse({ fields: OUTPUT_HEADERS, data: rows })
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
