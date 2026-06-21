/*
  send-template — minimal cloud send (ALERTS.md §15 steps 1–3, smoke test).

  The Deno/online equivalent of `python graph.py send-template`: read the stored Graph refresh
  token from `graph_credentials`, redeem + rotate it, fill the bundled template with sample lanes,
  and send via Microsoft Graph /me/sendMail. Sends from the seeded mailbox (luismht@).

  THROWAWAY TEST FUNCTION. Deployed with --no-verify-jwt → an OPEN endpoint that sends mail.
  Retire it once `notify-forwarders` works (ALERTS.md §16). Shares the Graph mechanics with
  notify-forwarders via ../_shared/graph.ts.

  Invoke (HTTP, since this CLI has no `functions invoke`):
    curl -X POST https://<ref>.supabase.co/functions/v1/send-template -d '{"to":"you@example.com"}'

  Secrets: MS_TENANT_ID, MS_CLIENT_ID. Optional: SENDER_NAME, APP_URL, SENDER (default recipient).
  Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
*/

import { createClient } from 'npm:@supabase/supabase-js@2'
import { fillTemplate, type FillLane } from '../_shared/fillTemplate.ts'
import { TEMPLATE_BYTES } from '../_shared/templateBytes.ts'
import { getAccessToken, invitationHtml, sendMail } from '../_shared/graph.ts'

// Sample lanes mirror graph.py's _sample_recipient(): one POD-blank, one POD-set.
const SAMPLE_LANES: FillLane[] = [
  { pol: 'Nhava Sheva, India', fd: 'Commerce, CA', pod: null, last_cy: null, container_type: "40' HC", container_count: 3 },
  { pol: 'Shanghai, China', fd: 'Chicago, IL', pod: 'Los Angeles, CA', last_cy: null, container_type: "40' GP", container_count: 1 },
]

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback
  if (v === undefined) throw new Error(`Missing required env: ${name}`)
  return v
}

Deno.serve(async (req) => {
  try {
    const tenantId = env('MS_TENANT_ID')
    const clientId = env('MS_CLIENT_ID')
    const senderName = env('SENDER_NAME', 'Luis')
    const appUrl = env('APP_URL', 'https://rates.ptpbags.com')
    const defaultTo = env('SENDER', 'luismht@primetimepackaging.com')

    let to = defaultTo
    try {
      const body = await req.json()
      if (body?.to) to = String(body.to)
    } catch {
      // no/invalid body → fall back to default recipient
    }

    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))
    const { accessToken, rotated } = await getAccessToken(supabase, tenantId, clientId)

    const xlsx = fillTemplate(TEMPLATE_BYTES, SAMPLE_LANES, 'Test Forwarder')
    const today = new Date().toISOString().slice(0, 10)
    await sendMail(
      accessToken,
      to,
      'PTP OFQ Rates — Test Send',
      invitationHtml({ senderName, appUrl }),
      xlsx,
      `PTP OFQ Rates - Test Forwarder - ${today}.xlsx`,
    )

    return Response.json({ ok: true, sent_to: to, rotated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('send-template error:', message) // never log the token
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
})
