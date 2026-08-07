/*
  Shared Microsoft Graph helpers (ALERTS.md §6c) — used by send-template (smoke test) and
  notify-forwarders. Token mechanics mirror graph.py: read the stored refresh token from
  graph_credentials, redeem it (public-client refresh grant — no secret), and PERSIST the rotated
  refresh token (rotation persistence = the keep-alive, §6c). Sends as the seeded mailbox via /me.
*/

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

// Refresh-grant scope — mirrors graph.py REFRESH_SCOPE.
const REFRESH_SCOPE = 'https://graph.microsoft.com/Mail.Send offline_access'

/** base64 for an arbitrary byte array (chunked to avoid call-stack limits on large inputs). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** The short invitation body (ALERTS.md §6a). Lanes ride in the attachment, not the body. */
export function invitationHtml(
  { senderName, appUrl, isReminder = false }:
    { senderName: string; appUrl: string; isReminder?: boolean },
): string {
  const lead = isReminder
    ? 'Just following up — we still need your rates for the lanes in the attached sheet.'
    : 'Attached is the rate request with the lanes we need quoted for this period.'
  return `<p>Hello,</p>
<p>${lead} Please complete the sheet (rate, carrier, port of discharge, last CY, free days…) and
indicate whether each shipment is <b>direct or involves a transshipment</b>.</p>
<p>Return your rates by uploading the completed sheet in our portal, or entering them directly:
<a href="${appUrl}">${appUrl}</a></p>
<p>Thanks,<br>${senderName}</p>`
}

/**
 * Token step ③ (ALERTS.md §6c): read graph_credentials → refresh-token grant → persist the rotated
 * refresh token. Returns the access token. Throws loudly on failure (→ re-seed via graph.py).
 */
// deno-lint-ignore no-explicit-any -- supabase-js client generics are awkward to thread through helpers
export async function getAccessToken(
  supabase: any,
  tenantId: string,
  clientId: string,
): Promise<{ accessToken: string; rotated: boolean }> {
  const { data: row, error } = await supabase
    .from('graph_credentials')
    .select('refresh_token')
    .eq('id', 1)
    .single()
  if (error || !row) {
    throw new Error(`graph_credentials read failed (seed it first): ${error?.message ?? 'no row'}`)
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: row.refresh_token as string,
      scope: REFRESH_SCOPE,
    }),
  })
  if (!resp.ok) {
    // ~90-day lapse, MFA, or conditional-access change invalidates the RT → re-seed (graph.py seed).
    throw new Error(`Refresh-token grant failed (${resp.status}) — re-seed required: ${await resp.text()}`)
  }
  const data = await resp.json()

  // Entra rotates the refresh token on each use — persist it or the chain dies (= keep-alive).
  let rotated = false
  if (data.refresh_token && data.refresh_token !== row.refresh_token) {
    const { error: upErr } = await supabase
      .from('graph_credentials')
      .update({ refresh_token: data.refresh_token, updated_at: new Date().toISOString() })
      .eq('id', 1)
    if (upErr) throw new Error(`Failed to persist rotated refresh token: ${upErr.message}`)
    rotated = true
  }
  return { accessToken: data.access_token as string, rotated }
}

/**
 * POST /v1.0/me/sendMail with an HTML body + one attachment. `to` may be one or many addresses.
 *
 * `contentType` defaults to xlsx so ocean and send-template are unaffected; drayage sends CSV.
 * It has to travel with the bytes — Outlook and Excel trust the declared MIME type over the file
 * extension, so a .csv announced as a spreadsheet opens as a corrupt workbook.
 */
export async function sendMail(
  accessToken: string,
  to: string | string[],
  subject: string,
  html: string,
  attachmentBytes: Uint8Array,
  attachmentName: string,
  contentType: string = XLSX_CONTENT_TYPE,
): Promise<void> {
  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }))
  if (recipients.length === 0) throw new Error('sendMail: no recipients')

  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: recipients,
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: attachmentName,
            contentType,
            contentBytes: toBase64(attachmentBytes),
          },
        ],
      },
      saveToSentItems: true,
    }),
  })
  if (resp.status !== 202) {
    throw new Error(`sendMail failed for ${recipients.map((r) => r.emailAddress.address).join(', ')}: ${resp.status} ${await resp.text()}`)
  }
}
