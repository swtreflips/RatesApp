/*
  notify-forwarders v2 — service-aware, per-analyst outbound send (ALERTS.md §3–§7, §14 + DRAY.md §7).

  One engine, three modes (`kind`), now parameterized by `service` (ocean | drayage):
    • preview  — the DIRECTORY: companies offering the service, their analysts (with tag flags),
                 per-company lane counts, and the last-send MEMORY (who was emailed last time for
                 THIS service — drives the modal's prefill, DRAY.md §7e). Sends nothing.
    • request  — all open lanes of the service → the analysts the sender CHECKED (`analystIds`)
    • reminder — only each company's OUTSTANDING lanes → the checked analysts

  Recipients are the explicit `analystIds` from the modal (DRAY.md §7b) — resolved server-side via
  get_recipients_by_analyst. Tags are guidance only and are NEVER used to filter recipients here.
  Audit: notifications.service + ONE notification_recipients row PER ANALYST (analyst_id) — these
  rows ARE next time's prefill memory.

  Each service sends its own template: ocean = PTP OFQ Rates (fillTemplate), drayage = the
  drayage template (fillDrayageTemplate — routing prefilled, money columns blank).

  Security (ALERTS.md §16): deploy WITH jwt verification. Caller must be an `internal` profile.
  Emails never reach the browser. Request shape: { kind, service?, forwarderIds?, analystIds?, period? }.

  Secrets: MS_TENANT_ID, MS_CLIENT_ID. Optional: SENDER_NAME, APP_URL.
  Auto-injected: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
*/

import { createClient } from 'npm:@supabase/supabase-js@2'
import { fillTemplate } from '../_shared/fillTemplate.ts'
import { TEMPLATE_BYTES } from '../_shared/templateBytes.ts'
import { fillDrayageTemplate } from '../_shared/fillDrayageTemplate.ts'
import { DRAYAGE_TEMPLATE_BYTES } from '../_shared/drayageTemplateBytes.ts'
import { getAccessToken, invitationHtml, sendMail } from '../_shared/graph.ts'

type Kind = 'request' | 'reminder' | 'preview'
type Service = 'ocean' | 'drayage'

type Lane = Record<string, unknown> & { id: string; period?: number | null }

/* Per-service pipeline config — mirrors the app's serviceConfig (DRAY.md §3).
   Ocean keeps the original table names; drayage points at the drayage_* mirrors.
   `fill` builds the attachment from that service's template + column map. */
const SERVICES: Record<Service, {
  lanesTable: string
  subsTable: string
  laneSelect: string
  hasPeriod: boolean
  attachmentPrefix: string
  fill: (lanes: Lane[], forwarderName: string) => Uint8Array
}> = {
  ocean: {
    lanesTable: 'rate_request_lanes',
    subsTable: 'rate_submissions',
    laneSelect: 'id, pol, pod, last_cy, fd, container_type, container_count, period',
    hasPeriod: true,
    attachmentPrefix: 'PTP OFQ Rates',
    fill: (lanes, forwarderName) => fillTemplate(
      TEMPLATE_BYTES,
      lanes.map((l) => ({
        pol: l.pol as string | null, fd: l.fd as string | null,
        pod: l.pod as string | null, last_cy: l.last_cy as string | null,
        container_type: l.container_type as string | null,
        container_count: l.container_count as number | null,
      })),
      forwarderName,
    ),
  },
  drayage: {
    lanesTable: 'drayage_request_lanes',
    subsTable: 'drayage_submissions',
    laneSelect: 'id, last_cy_cfs, final_destination, dest_zip, notes',
    hasPeriod: false,
    attachmentPrefix: 'PTP Drayage Rates',
    fill: (lanes) => fillDrayageTemplate(
      DRAYAGE_TEMPLATE_BYTES,
      lanes.map((l) => ({
        last_cy_cfs: l.last_cy_cfs as string | null,
        final_destination: l.final_destination as string | null,
        dest_zip: l.dest_zip as string | null,
        notes: l.notes as string | null,
      })),
    ),
  },
}

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback
  if (v === undefined) throw new Error(`Missing required env: ${name}`)
  return v
}

// CORS — the modal calls this cross-origin from the browser, so answer the preflight + echo headers.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  })

Deno.serve(async (req) => {
  // CORS preflight — must return before any auth/work.
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // ── parse ──
    const { kind, service: svcParam, forwarderIds, analystIds, period } =
      await req.json().catch(() => ({})) as {
        kind?: Kind; service?: string; forwarderIds?: string[]
        analystIds?: string[]; period?: number | null
      }
    if (kind !== 'request' && kind !== 'reminder' && kind !== 'preview') {
      return json({ ok: false, error: "kind must be 'request' | 'reminder' | 'preview'" }, 400)
    }
    const svc: Service = svcParam === 'drayage' ? 'drayage' : 'ocean' // default ocean (back-compat)
    if (svcParam && svcParam !== 'ocean' && svcParam !== 'drayage') {
      return json({ ok: false, error: "service must be 'ocean' | 'drayage'" }, 400)
    }
    const cfg = SERVICES[svc]

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

    // ── companies offering THIS service (capability gate, DRAY.md §2a) ──
    // Kept even for companies with zero analysts so the modal can show "no active recipients".
    let capQuery = service
      .from('forwarder_services')
      .select('forwarder_id, forwarders!inner(id, name, active)')
      .eq('service', svc)
      .eq('active', true)
    if (Array.isArray(forwarderIds) && forwarderIds.length > 0) {
      capQuery = capQuery.in('forwarder_id', forwarderIds)
    }
    const { data: capRows, error: fErr } = await capQuery
    if (fErr) throw new Error(`capability read failed: ${fErr.message}`)
    const companies = (capRows ?? [])
      .map((r) => r.forwarders as unknown as { id: string; name: string; active: boolean })
      .filter((f) => f.active)
    const ids = companies.map((f) => f.id)
    if (ids.length === 0) return json({ ok: true, kind, service: svc, roster: [], sent: [], failed: [] })

    // ── full service list per company (modal caps tag chips by capability, DRAY.md §7a) ──
    const { data: allSvcRows } = await service
      .from('forwarder_services')
      .select('forwarder_id, service')
      .in('forwarder_id', ids)
      .eq('active', true)
    const servicesByForwarder = new Map<string, string[]>()
    for (const r of allSvcRows ?? []) {
      const list = servicesByForwarder.get(r.forwarder_id) ?? []
      list.push(r.service)
      servicesByForwarder.set(r.forwarder_id, list)
    }

    // ── DIRECTORY: every analyst of each company, with tag flags (DRAY.md §7b) ──
    const { data: dirRows, error: dErr } = await service
      .rpc('get_service_directory', { p_forwarder_ids: ids, p_service: svc })
    if (dErr) throw new Error(`directory resolve failed: ${dErr.message}`)
    type DirRow = {
      forwarder_id: string; forwarder_name: string; analyst_id: string
      analyst_name: string; email: string; tag_ocean: boolean; tag_drayage: boolean
    }
    const analystsByForwarder = new Map<string, DirRow[]>()
    for (const r of (dirRows ?? []) as DirRow[]) {
      const list = analystsByForwarder.get(r.forwarder_id) ?? []
      list.push(r)
      analystsByForwarder.set(r.forwarder_id, list)
    }

    // ── MEMORY (DRAY.md §7e): latest send of THIS service per company → its analyst set.
    // Derived from the audit rows; rows from pre-v2 sends have analyst_id null → empty memory
    // → the modal starts blank for that company (cold start, by design).
    const { data: memRows, error: mErr } = await service
      .from('notification_recipients')
      .select('forwarder_id, analyst_id, status, sent_at, notification:notifications!inner(id, service, created_at)')
      .eq('notification.service', svc)
    if (mErr) throw new Error(`memory read failed: ${mErr.message}`)
    type MemRow = {
      forwarder_id: string; analyst_id: string | null; status: string; sent_at: string | null
      notification: { id: string; service: string; created_at: string }
    }
    const sortedMem = ((memRows ?? []) as unknown as MemRow[])
      .sort((a, b) => b.notification.created_at.localeCompare(a.notification.created_at))
    const latestNotifByForwarder = new Map<string, string>() // company → latest notification id
    const memoryByForwarder = new Map<string, Set<string>>() // company → analyst ids of that send
    const lastNotifiedAt = new Map<string, string>()         // company → last successful sent_at
    for (const r of sortedMem) {
      if (!latestNotifByForwarder.has(r.forwarder_id)) {
        latestNotifByForwarder.set(r.forwarder_id, r.notification.id)
      }
      if (latestNotifByForwarder.get(r.forwarder_id) === r.notification.id && r.analyst_id) {
        const set = memoryByForwarder.get(r.forwarder_id) ?? new Set<string>()
        set.add(r.analyst_id)
        memoryByForwarder.set(r.forwarder_id, set)
      }
      if (r.status === 'sent' && r.sent_at && !lastNotifiedAt.has(r.forwarder_id)) {
        lastNotifiedAt.set(r.forwarder_id, r.sent_at)
      }
    }

    // ── open lanes of THIS service (re-validated at send time) + acks for the outstanding anti-join ──
    let laneQuery = service
      .from(cfg.lanesTable)
      .select(cfg.laneSelect)
      .gt('expires_at', new Date().toISOString())
    if (cfg.hasPeriod && period != null) laneQuery = laneQuery.eq('period', period)
    const { data: lanes, error: lErr } = await laneQuery
    if (lErr) throw new Error(`lanes read failed: ${lErr.message}`)
    const openLanes = (lanes ?? []) as unknown as Lane[]

    const ackKey = (forwarderId: string, laneId: string, period?: number | null) =>
      cfg.hasPeriod ? `${forwarderId}|${laneId}|${period ?? ''}` : `${forwarderId}|${laneId}`

    const { data: acks, error: aErr } = await service
      .from(cfg.subsTable)
      .select(cfg.hasPeriod ? 'lane_id, forwarder_id, period, status' : 'lane_id, forwarder_id, status')
    if (aErr) throw new Error(`submissions read failed: ${aErr.message}`)
    const ackStatus = new Map<string, string>()
    for (const a of acks ?? []) {
      ackStatus.set(ackKey(a.forwarder_id, a.lane_id, (a as { period?: number | null }).period), a.status)
    }

    const lanesFor = (forwarderId: string): Lane[] =>
      kind === 'reminder'
        ? openLanes.filter((l) => !ackStatus.has(ackKey(forwarderId, l.id, l.period)))
        : openLanes

    // ── PREVIEW: directory + memory + counts, no send ──
    if (kind === 'preview') {
      const roster = companies.map((f) => {
        let responded = 0, skipped = 0, outstanding = 0
        for (const l of openLanes) {
          const s = ackStatus.get(ackKey(f.id, l.id, l.period))
          if (s === 'submitted') responded++
          else if (s === 'skipped') skipped++
          else outstanding++
        }
        const memory = memoryByForwarder.get(f.id) ?? new Set<string>()
        const analysts = (analystsByForwarder.get(f.id) ?? []).map((a) => ({
          analystId: a.analyst_id,
          name: a.analyst_name,
          email: a.email,
          tagOcean: a.tag_ocean,
          tagDrayage: a.tag_drayage,
          lastSelected: memory.has(a.analyst_id), // §7e prefill; false everywhere = blank first send
        }))
        return {
          forwarderId: f.id,
          name: f.name,
          services: servicesByForwarder.get(f.id) ?? [svc], // for chip capping (§7a)
          openCount: openLanes.length,
          outstandingCount: outstanding,
          respondedCount: responded,
          skippedCount: skipped,
          analysts,
          recipientCount: analysts.length,
          lastNotifiedAt: lastNotifiedAt.get(f.id) ?? null,
        }
      })
      return json({ ok: true, kind, service: svc, roster })
    }

    // ── REQUEST / REMINDER: resolve the CHECKED analysts, send per company, audit per analyst ──
    if (!Array.isArray(analystIds) || analystIds.length === 0) {
      return json({ ok: false, error: 'No recipients selected — pass analystIds' }, 400)
    }

    const { data: recRows, error: rErr } = await service
      .rpc('get_recipients_by_analyst', { p_analyst_ids: analystIds })
    if (rErr) throw new Error(`recipient resolve failed: ${rErr.message}`)
    type RecRow = { forwarder_id: string; forwarder_name: string; analyst_id: string; email: string }
    const recipientsByForwarder = new Map<string, RecRow[]>()
    for (const r of (recRows ?? []) as RecRow[]) {
      const list = recipientsByForwarder.get(r.forwarder_id) ?? []
      list.push(r)
      recipientsByForwarder.set(r.forwarder_id, list)
    }

    const senderName = env('SENDER_NAME', 'Luis')
    const appUrl = env('APP_URL', 'https://rates.ptpbags.com')
    const isReminder = kind === 'reminder'
    const today = new Date().toISOString().slice(0, 10)
    const subject = isReminder ? 'Reminder: Rate Request' : 'Rate Request'

    const { data: notif, error: nErr } = await service
      .from('notifications')
      .insert({ kind, service: svc, triggered_by: user.id, period: period ?? null })
      .select('id')
      .single()
    if (nErr) throw new Error(`notifications insert failed: ${nErr.message}`)

    const { accessToken } = await getAccessToken(service, env('MS_TENANT_ID'), env('MS_CLIENT_ID'))

    const sent: Array<{ forwarderId: string; lanes: number; emails: number }> = []
    const failed: Array<{ forwarderId: string; error: string }> = []

    // Send one email per COMPANY (to all its checked analysts), audit one row PER ANALYST —
    // the per-analyst rows are what the §7e memory reads back next time.
    for (const f of companies) {
      const recipients = recipientsByForwarder.get(f.id) ?? []
      if (recipients.length === 0) continue // no analyst of this company was checked
      const forwarderLanes = lanesFor(f.id)
      if (forwarderLanes.length === 0) continue // nothing outstanding → don't email (ALERTS.md §9)

      const emails = recipients.map((r) => r.email)
      let status: 'sent' | 'failed' = 'sent'
      let errorMsg: string | null = null
      let sentAt: string | null = null
      try {
        const xlsx = cfg.fill(forwarderLanes, f.name)
        await sendMail(
          accessToken,
          emails,
          subject,
          invitationHtml({ senderName, appUrl, isReminder }),
          xlsx,
          `${cfg.attachmentPrefix} - ${String(f.name).replace(/\//g, '-')} - ${today}.xlsx`,
        )
        sentAt = new Date().toISOString()
        sent.push({ forwarderId: f.id, lanes: forwarderLanes.length, emails: emails.length })
      } catch (err) {
        status = 'failed'
        errorMsg = err instanceof Error ? err.message : String(err)
        failed.push({ forwarderId: f.id, error: errorMsg })
      }

      await service.from('notification_recipients').insert(
        recipients.map((r) => ({
          notification_id: notif.id,
          forwarder_id: f.id,
          analyst_id: r.analyst_id,
          email: r.email,
          lane_count: forwarderLanes.length,
          status,
          error: errorMsg,
          sent_at: sentAt,
        })),
      )
    }

    return json({ ok: true, kind, service: svc, notificationId: notif.id, sent, failed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('notify-forwarders error:', message) // never log the token
    return json({ ok: false, error: message }, 500)
  }
})
