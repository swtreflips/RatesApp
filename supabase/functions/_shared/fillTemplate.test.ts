/*
  Standalone verification harness for fillTemplate() — no Supabase project or Graph token needed.

  Run:
    deno run --allow-read --allow-write supabase/functions/_shared/fillTemplate.test.ts

  Produces ./out.xlsx (repo root). Open it in Excel and confirm (ALERTS.md verification):
    • lane values land in C/D/H/I/L (+ M/N when set) starting at row 2; forwarder cols blank
    • the M/N/S dropdowns are STILL present (click a cell → dropdown arrow)
    • styling / column widths / print area look like the original template
    • the Validation sheet is intact
  Then round-trip: upload out.xlsx back through the app's inbound parseRateFile.
*/

import { fillTemplate, type FillLane } from './fillTemplate.ts'
import { TEMPLATE_BYTES } from './templateBytes.ts'

// Sample lanes mirror graph.py's _sample_recipient(): one POD-blank, one POD-set.
const SAMPLE_LANES: FillLane[] = [
  { pol: 'Nhava Sheva, India', fd: 'Commerce, CA', pod: null, last_cy: null, container_type: "40' HC", container_count: 3 },
  { pol: 'Shanghai, China', fd: 'Chicago, IL', pod: 'Los Angeles, CA', last_cy: null, container_type: "40' GP", container_count: 1 },
]

const templateBytes = TEMPLATE_BYTES

const filled = fillTemplate(templateBytes, SAMPLE_LANES, 'Test Forwarder')
await Deno.writeFile('out.xlsx', filled)

console.log(`✅ wrote out.xlsx (${filled.byteLength} bytes) from ${SAMPLE_LANES.length} lane(s)`)

// Sanity: 0-lane input still yields a valid file (just headers).
const empty = fillTemplate(templateBytes, [], 'Nobody')
console.log(`✅ 0-lane fill ok (${empty.byteLength} bytes)`)
