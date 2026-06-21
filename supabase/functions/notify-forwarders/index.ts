/*
  notify-forwarders — the real outbound send (ALERTS.md §3–§7, §14).

  Computes lanes-per-forwarder from open requests and emails each forwarder a filled copy of the
  template. One engine, three modes (`kind`):
    • request  — all open lanes → the selected (default: all active) forwarders
    • reminder — only each forwarder's OUTSTANDING lanes (no ack yet); answered forwarders drop out
    • preview  — compute the response roster + recipient counts and SEND NOTHING (drives the UI modal)

  Security (ALERTS.md §16): deploy WITH jwt verification. Caller must be an `internal` profile.
  The client sends `forwarderIds` only — emails are resolved server-side via get_forwarder_recipients
  (auth.users never reaches the browser). Request shape: { kind, forwarderIds?, period? }.

  Secrets: MS_TENANT_ID, MS_CLIENT_ID. Optional: SENDER_NAME, APP_URL.
  Auto-injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
*/

import { createClient } from 'npm:@supabase/supabase-js@2'
import { fillTemplate, type FillLane } from '../_shared/fillTemplate.ts'
import { TEMPLATE_BYTES } from '../_shared/templateBytes.ts'
import { getAccessToken, invitationHtml, sendMail } from '../_shared/graph.ts'

type Kind = 'request' | 'reminder' | 'preview'

type Lane = {
  id: string
  pol: string | null
  pod: string | null
  last_cy: string | null
  fd: string | null
  container_type: string | null
  container_count: number | null
  period: number | null
}

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback
  if (v === undefined) throw new Error(`Missing required env: ${name}`)
  return v
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ackKey = (forwarderId: string, laneId: string, period: number | null) =>
  `${forwarderId}|${laneId}|${period ?? ''}`

Deno.serve(async (req) => {
  try {
    // ── parse ──
    const { kind, forwarderIds, period } = await req.json().catch(() => ({})) as {
      kind?: Kind; forwarderIds?: string[]; period?: number | null
    }
    if (kind !== 'request' && kind !== 'reminder' && kind !== 'preview') {
      return json({ ok: false, error: "kind must be 'request' | 'reminder' | 'preview'" }, 400)
    }

    const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'))

    // ── role-gate (ALERTS.md §16): caller must be an internal profile ──
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user } } = await userClient.auth.getUser()
    if (!user) return json({ ok: false, error: 'Not authenticated' }, 401)
    const { data: prof } = await service.from('profiles').select('role').eq('id', user.id).single()
    if (prof?.role !== 'internal') return json({ ok: false, error: 'Forbidden — internal only' }, 403)

    // ── the forwarder set: explicit list, else all active ──
    let forwarderQuery = service.from('forwarders').select('id, name').eq('active', true)
    if (Array.isArray(forwarderIds) && forwarderIds.length > 0) {
      forwarderQuery = forwarderQuery.in('id', forwarderIds)
    }
    const { data: forwarders, error: fErr } = await forwarderQuery
    if (fErr) throw new Error(`forwarders read failed: ${fErr.message}`)
    const ids = (forwarders ?? []).map((f) => f.id)
    if (ids.length === 0) return json({ ok: true, kind, roster: [], sent: [], failed: [] })

    // ── recipient emails (server-side resolve; grouped per forwarder) ──
    const { data: recRows, error: rErr } = await service
      .rpc('get_forwarder_recipients', { p_forwarder_ids: ids })
    if (rErr) throw new Error(`recipient resolve failed: ${rErr.message}`)
    const emailsByForwarder = new Map<string, string[]>()
    for (const r of recRows ?? []) {
      const list = emailsByForwarder.get(r.forwarder_id) ?? []
      list.push(r.email)
      emailsByForwarder.set(r.forwarder_id, list)
    }

    // ── open lanes (re-validated at send time, ALERTS.md §11) + acks for the outstanding anti-join ──
    let laneQuery = service
      .from('rate_request_lanes')
      .select('id, pol, pod, last_cy, fd, container_type, container_count, period')
      .gt('expires_at', new Date().toISOString())
    if (period != null) laneQuery = laneQuery.eq('period', period)
    const { data: lanes, error: lErr } = await laneQuery
    if (lErr) throw new Error(`lanes read failed: ${lErr.message}`)
    const openLanes = (lanes ?? []) as Lane[]

    const { data: acks, error: aErr } = await service
      .from('rate_submissions')
      .select('lane_id, forwarder_id, period, status')
    if (aErr) throw new Error(`submissions read failed: ${aErr.message}`)
    const ackStatus = new Map<string, string>() // forwarder|lane|period → 'submitted'|'skipped'
    for (const a of acks ?? []) ackStatus.set(ackKey(a.forwarder_id, a.lane_id, a.period), a.status)

    // last-notified per forwarder (ALERTS.md §9), for the roster
    const { data: lastNotif } = await service
      .from('notification_recipients')
      .select('forwarder_id, sent_at')
      .eq('status', 'sent')
      .not('sent_at', 'is', null)
      .order('sent_at', { ascending: false })
    const lastNotifiedAt = new Map<string, string>()
    for (const n of lastNotif ?? []) {
      if (!lastNotifiedAt.has(n.forwarder_id)) lastNotifiedAt.set(n.forwarder_id, n.sent_at)
    }

    // lanes for a forwarder under the current kind
    const lanesFor = (forwarderId: string): Lane[] =>
      kind === 'reminder'
        ? openLanes.filter((l) => !ackStatus.has(ackKey(forwarderId, l.id, l.period)))
        : openLanes // request / preview-base = all open lanes

    // ── PREVIEW: roster only, no send ──
    if (kind === 'preview') {
      const roster = (forwarders ?? []).map((f) => {
        let responded = 0, skipped = 0, outstanding = 0
        for (const l of openLanes) {
          const s = ackStatus.get(ackKey(f.id, l.id, l.period))
          if (s === 'submitted') responded++
          else if (s === 'skipped') skipped++
          else outstanding++
        }
        return {
          forwarderId: f.id,
          name: f.name,
          openCount: openLanes.length,
          outstandingCount: outstanding,
          respondedCount: responded,
          skippedCount: skipped,
          recipientCount: (emailsByForwarder.get(f.id) ?? []).length,
          lastNotifiedAt: lastNotifiedAt.get(f.id) ?? null,
        }
      })
      return json({ ok: true, kind, roster })
    }

    // ── REQUEST / REMINDER: send + audit ──
    const senderName = env('SENDER_NAME', 'Luis')
    const appUrl = env('APP_URL', 'https://rates.ptpbags.com')
    const isReminder = kind === 'reminder'
    const today = new Date().toISOString().slice(0, 10)
    const subject = isReminder ? 'Reminder: Rate Request' : 'Rate Request'

    const { data: notif, error: nErr } = await service
      .from('notifications')
      .insert({ kind, triggered_by: user.id, period: period ?? null })
      .select('id')
      .single()
    if (nErr) throw new Error(`notifications insert failed: ${nErr.message}`)

    const { accessToken } = await getAccessToken(service, env('MS_TENANT_ID'), env('MS_CLIENT_ID'))

    const sent: Array<{ forwarderId: string; lanes: number; emails: number }> = []
    const failed: Array<{ forwarderId: string; error: string }> = []

    for (const f of forwarders ?? []) {
      const forwarderLanes = lanesFor(f.id)
      const emails = emailsByForwarder.get(f.id) ?? []
      if (forwarderLanes.length === 0) continue // nothing outstanding → don't email (ALERTS.md §9)

      const recip = {
        notification_id: notif.id,
        forwarder_id: f.id,
        email: emails.join(', ') || null,
        lane_count: forwarderLanes.length,
        status: 'queued' as 'queued' | 'sent' | 'failed',
        error: null as string | null,
        sent_at: null as string | null,
      }

      if (emails.length === 0) {
        recip.status = 'failed'
        recip.error = 'no active recipients (missing email / opted out / forwarder inactive)'
        failed.push({ forwarderId: f.id, error: recip.error })
      } else {
        try {
          const fillLanes: FillLane[] = forwarderLanes.map((l) => ({
            pol: l.pol, fd: l.fd, pod: l.pod, last_cy: l.last_cy,
            container_type: l.container_type, container_count: l.container_count,
          }))
          const xlsx = fillTemplate(TEMPLATE_BYTES, fillLanes, f.name)
          await sendMail(
            accessToken,
            emails,
            subject,
            invitationHtml({ senderName, appUrl, isReminder }),
            xlsx,
            `PTP OFQ Rates - ${String(f.name).replace(/\//g, '-')} - ${today}.xlsx`,
          )
          recip.status = 'sent'
          recip.sent_at = new Date().toISOString()
          sent.push({ forwarderId: f.id, lanes: forwarderLanes.length, emails: emails.length })
        } catch (err) {
          recip.status = 'failed'
          recip.error = err instanceof Error ? err.message : String(err)
          failed.push({ forwarderId: f.id, error: recip.error })
        }
      }

      await service.from('notification_recipients').insert(recip)
    }

    return json({ ok: true, kind, notificationId: notif.id, sent, failed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('notify-forwarders error:', message) // never log the token
    return json({ ok: false, error: message }, 500)
  }
})
