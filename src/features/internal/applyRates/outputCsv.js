/*
  Apply Rates — build + download the output CSV in the AIS import template shape
  (ratesTemplate.csv). Header order is load-bearing: keep it byte-identical.
*/

import Papa from 'papaparse'

export const OUTPUT_HEADERS = [
  '# of Free Days', 'Carrier', 'Contract Number', 'Date Received', 'External ID',
  'Final Destination', 'Forwarder/Carrier', 'Last CY/CFS', 'Last CY/CFS ETA', 'Move',
  'Ocean Freight Quote', 'Port of Discharge', 'Port of Loading', 'Rate/Unit',
  'Shipping Mode', 'Valid Until', 'Vessel ETA', 'Vessel ETD',
]

// matchOfq() results → one output row per applied rate. Unmapped columns stay blank;
// Move is fixed CY/CY; Valid Until passes through as stored (ISO).
export function buildOutputRows(results) {
  const rows = []
  for (const res of results) {
    for (const r of res.applied) {
      rows.push([
        r.free_days ?? '',        // # of Free Days
        r.carrier ?? '',          // Carrier
        '',                       // Contract Number
        '',                       // Date Received
        '',                       // External ID
        res.fd ?? '',             // Final Destination (from the OFQ)
        r.forwarder?.name ?? '',  // Forwarder/Carrier
        r.last_cy ?? '',          // Last CY/CFS
        '',                       // Last CY/CFS ETA
        'CY/CY',                  // Move
        res.ofqId,                // Ocean Freight Quote
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
