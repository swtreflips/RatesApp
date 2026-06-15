# Alerts & Notifications Model

**Status:** Design spec. **Not implemented.** Build during/after the MOCKDEPLOY rehearsal.
**Created:** June 15, 2026
**Relates to:** `CLAUDE.md` (Edge Functions for notifications), `PROVIDER_VIEW_MODEL.md`
§6 (response roster), `COVERAGE_MODEL.md` (per-forwarder lane relevance), `MOCKDEPLOY.md`
(M365 tenant + Cloudflare gate).

**Locked decisions:** emails are sent **truly from the M365 / Outlook mailbox**;
orchestration is **Power Automate** (M365-native) triggered from Supabase; the forwarder
email carries **full lane details inline**; outbound sending is **manual and
requester-controlled**, never automatic per lane-post.

---

## 1. Two directions

| Dir | From → To | Trigger | "Here is…" |
|-----|-----------|---------|------------|
| **Outbound (demand)** | requester → forwarders | **manual button** | the lanes we need rates for |
| **Inbound (supply)** | forwarder → requester team | **automatic on submit** | rates a forwarder just sent |

## 2. Outbound principle — manual, batched, controlled

Notifications are **not** fired when a lane is posted (annoying — lanes are drafted
continuously). The requester accumulates a period's lanes, then **explicitly sends**.
Two intents:
- **Initial request** — "here are the lanes for this period."
- **Reminder** — "you haven't sent rates yet" — to **non-responders only**.

Re-sendable: new lanes added mid-period can be sent again without re-announcing answered ones.

## 3. The unifying model — "lanes per forwarder"

Both intents compute, for each selected forwarder, a **set of lanes**, then send **one
email per forwarder**. Only the lane set differs:

| | Initial request | Reminder |
|---|---|---|
| Lanes per forwarder | **all** open lanes (active TTL, this period) | only that forwarder's **outstanding** lanes |
| Outstanding = | (everything) | open lanes with **no acknowledgement** from that forwarder |
| Default recipients | all active forwarders | forwarders with ≥1 outstanding lane |
| Forwarder who answered everything | included | **drops out automatically** |

"Outstanding" reuses the existing per-`(forwarder, lane, period)` anti-join from
[`fetchActiveLanes()`](src/features/provider/services/submissionService.js).
**"Responded" = a `rate_submissions` ack (status `submitted` OR `skipped`)** — a skip is a
real answer, so skippers aren't reminded. Because reminder lanes are computed per forwarder,
"Forwarder A already responded → A gets no reminder" falls out for free, and a forwarder who
answered the first 5 lanes still gets reminded about a 6th added later.

## 4. Recipient selection — three button patterns

The requester wants to choose who receives, with an **"All"** option, and treat reminders
differently. Three patterns:

**Option A — Two buttons (the user's instinct).**
`Send Rate Request` (all forwarders, full open-lane list, confirm dialog) +
`Send Reminder…` (modal pre-filtered to non-responders & their outstanding lanes).
*Pro:* clearest mental model. *Con:* two UI/code paths.

**Option B — One button + configurable modal.**
`Send Notification` → modal with a type toggle [Initial | Reminder], a recipient list
(All + per-forwarder checkboxes with response badges), and a lane preview.
*Pro:* one flow, total control each send. *Con:* more clicks for the common blast.

**Option C — Hybrid (RECOMMENDED).**
`Send Rate Request` fast-path (defaults to all forwarders + all open lanes) **plus**
`Send Reminder…` opening the selection modal defaulting to pending forwarders. **Both share
one send pipeline and one modal component** — reminder just pre-filters. Keeps the user's
two-button instinct with a single backend path.

**Selection modal (shared):** forwarder rows with a response badge
(`✓ responded m/n` · `— pending` · `⤫ skipped`), an **All** master toggle, per-forwarder
checkbox, a per-recipient lane preview, and a **"last notified"** timestamp.

## 5. Where it lives

The **Open Requests** page ([OpenRequests.jsx](src/features/requester/pages/OpenRequests.jsx))
— it already lists the period's active lanes. Add header actions `[Send Rate Request]
[Send Reminder…]`. Surfacing the `PROVIDER_VIEW_MODEL.md` §6 **response roster** here (who
has/hasn't responded per lane) both powers reminders and is independently useful.

## 6. Architecture / orchestration

```
Requester (browser)
   │  supabase.functions.invoke('notify-forwarders', { kind, forwarderIds, period })
   ▼
Supabase Edge Function           ← verifies JWT + profiles.role='requester'
   │  • resolves forwarder emails (service role)        (emails never touch the browser)
   │  • computes lanes-per-forwarder (§3), re-validates active lanes
   │  • writes the audit log (§7)
   │  • POSTs clean JSON to the Power Automate HTTP trigger (URL = function secret)
   ▼
Power Automate (HTTP-triggered flow)
   │  • "Send an email from a shared mailbox (V2)"
   │  • loops recipients, builds the HTML lane table from JSON
   ▼
Outlook / M365 (shared mailbox, e.g. rates@ptpbags.com) → forwarders
```

**Why the Edge Function in the middle (not browser → Power Automate directly):**
- The PA HTTP-trigger URL embeds a SAS signature — a **secret**. Keep it out of the client
  bundle (Supabase function secret, never a `VITE_` var).
- **Forwarder emails stay server-side.** The client sends `forwarderIds`; the function
  resolves addresses. The browser never holds the recipient list.
- **Role-gated:** only `requester` profiles can blast.
- One place to assemble the per-forwarder payload and write the log.

**Sender = a shared mailbox** (e.g. `rates@ptpbags.com`), recommended over a personal
mailbox: the team sees replies, it survives staffing changes, and PA's shared-mailbox
action supports it. Replies still land in your tenant — matching the manual flow.

**Alternative trigger (event-sourced):** insert a `notifications` row → **Supabase Database
Webhook** → Power Automate. "Insert = send," fully decoupled/auditable, but more moving
parts. Use only if you prefer event sourcing over the direct relay.

**Payload sketch:**
```json
{
  "kind": "request",
  "sentBy": "Jordan",
  "recipients": [
    { "forwarderId": "…", "name": "Tanera Transport", "email": "silvia@…",
      "lanes": [ { "pol": "Nhava Sheva, India", "pod": null, "lastCy": null,
                   "fd": "Commerce, CA", "containerType": "40' HC", "containerCount": 3 } ] }
  ],
  "appUrl": "https://rates.ptpbags.com"
}
```

## 7. Data model — audit log (NOT the source of "who responded")

"Who responded" is always **derived from `rate_submissions`** (§3). This log exists for
**audit, "last notified at," failure tracking, and a future in-app notification center**
(the bell reads it).

```sql
create table notifications (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('request','reminder')),
  triggered_by uuid not null references auth.users(id),
  period       integer,
  created_at   timestamptz not null default now()
);
create table notification_recipients (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  forwarder_id    uuid not null references forwarders(id),
  email           text,                       -- snapshot
  lane_count      integer,
  status          text not null default 'queued' check (status in ('queued','sent','failed')),
  error           text,
  sent_at         timestamptz
);
-- optional: notification_lanes(notification_id, lane_id) for a full lane snapshot per send
-- RLS: requester reads/inserts own; providers: no access.
```

## 8. Inbound — forwarder submits → requester team

Automatic, but **one notification per submit action, not per lane/ack row** — a forwarder
filling 10 lanes must not generate 10 emails.

- **Recommended:** on `submitRates()` success in
  [SubmitRates.jsx](src/features/provider/pages/SubmitRates.jsx), call an Edge Function
  `notify-submission` **once**, summarizing "Forwarder X submitted N rates across M lanes" →
  Power Automate → team. (Naturally batches; mirrors the outbound relay.)
- **Recipients:** the shared mailbox / a team distro / all `requester` profiles.
- **Channel:** email; optionally a **Microsoft Teams** post (PA does both) since you're in M365.
- *Alternative:* DB webhook on `rate_submissions` insert with debounce — more complex; the
  client-invoke above is simpler and inherently per-action.

## 9. Anti-annoyance / throttling

- Outbound is **manual only**.
- Show **"last notified"** per period; **warn on re-send within a cooldown** (e.g. < 12h).
- Reminders skip already-responded forwarders **by construction** (§3).
- A forwarder with **zero outstanding/relevant lanes is never emailed**.

## 10. Security & config

- **Secrets** (Supabase function env, never client/`VITE_`): the Power Automate trigger
  URL(s), the sender mailbox address.
- **Role-gate** every notify function (JWT + `profiles.role`).
- `src/lib/constants.js` (planned in NEXTSTEPS A0): `REMINDER_COOLDOWN_HOURS`, sender
  display name; team recipients live in DB or config.

## 11. Edge cases

- Lane **expires between compose and send** → function re-validates active lanes at send time.
- Forwarder **missing email / inactive** → skip + flag in the log.
- **Coverage** (future, `COVERAGE_MODEL.md`): subtract coverage-excluded lanes from a
  forwarder's set; a forwarder covering none of the open lanes drops out. The
  "lanes-per-forwarder" model already accommodates this as one more predicate.
- **Partial PA failures** → per-recipient `status='failed'` + `error`; surface in the UI with retry.
- **M365 limits** (~30 msgs/min, ~10k recipients/day) — ample at this scale; mind the loop if
  forwarder counts grow large.

## 12. Phasing

- **Phase 1 (rehearsal):** Edge Function + Power Automate + shared mailbox; outbound
  request + reminder from Open Requests; audit log; inbound submit → team email. Free-text
  lanes acceptable.
- **Phase 2:** response roster UI on Open Requests; in-app notification center (bell reads
  `notifications`); Teams channel; coverage-aware per-forwarder filtering; digesting.

## 13. Decisions to confirm before building

| Decision | Recommended |
|---|---|
| Button pattern | **C — hybrid** (fast `Send Rate Request` + `Send Reminder…` modal, shared pipeline) |
| Trigger | **Edge Function relay** (vs DB-webhook event-sourced) |
| Sender mailbox | **Shared mailbox** (vs personal Outlook) |
| Inbound mechanism | **Client-invoke once per submit** (vs webhook + debounce) |
| Inbound channel | Email now; **Teams** optional later |
| Reminder content | **Per-forwarder outstanding lanes** (vs same full list) |
