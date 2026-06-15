# Alerts & Notifications Model

**Status:** Design spec. **Not implemented.** Build during/after the MOCKDEPLOY rehearsal.
**Created:** June 15, 2026
**Relates to:** `CLAUDE.md` (Edge Functions for notifications), `PROVIDER_VIEW_MODEL.md`
§6 (response roster), `COVERAGE_MODEL.md` (per-forwarder lane relevance), `MOCKDEPLOY.md`
(M365 tenant + Cloudflare gate).

**Locked decisions / tech stack:** emails are sent **truly from the M365 / Outlook mailbox**
via the **Microsoft Graph API** (`sendMail`), called from a **Supabase Edge Function** —
reusing the Graph integration already built for an internal CRM (Azure app registration,
token flow, and compose/send are solved). The forwarder email carries **full lane details
inline**; outbound sending is **manual and requester-controlled**, never automatic per
lane-post. (Power Automate is a low-code fallback only — **not used here**, since Graph is
already wired.)

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
   │  • builds the HTML body, calls Microsoft Graph sendMail (app-only token)
   ▼
Microsoft Graph   POST /users/{shared-mailbox}/sendMail
   ▼
Outlook / M365 (shared mailbox, e.g. rates@ptpbags.com) → forwarders
```

**Tech stack is settled: Supabase Edge Function → Microsoft Graph `sendMail`.** The Graph
integration (Azure app registration, client-credentials token flow, compose/send helpers)
already exists from an internal CRM and is reused here — so there is **no Power Automate, no
third-party email provider, and no separate flow surface to maintain.** Everything lives in
code, in this repo's Supabase functions.

**Why the Edge Function in the middle (not browser → Graph directly):**
- The **Graph client secret** must never reach the browser → stored as a Supabase function
  secret (never a `VITE_` var).
- **Forwarder emails stay server-side.** The client sends `forwarderIds`; the function
  resolves addresses from `profiles` / `auth.users`. The browser never holds the recipient list.
- **Role-gated:** only `requester` profiles can blast.
- One place to assemble the per-forwarder body, call Graph, and write the log.

**Auth = app-only (client credentials), permission `Mail.Send`.** Server-triggered sends have
no signed-in user, so application permission is the correct mode (delegated / on-behalf-of is
for user-initiated sends). Confirm the CRM app is app-only; if it's delegated, that's the one
piece to adjust.

**Sender mailbox — phased, and a config value (not hardcoded).** The target is
`POST /users/{sender-mailbox}/sendMail`, where `{sender-mailbox}` is an Edge Function
**config/secret** so it changes with **zero code edits**:

- **Phase 1 (initial deploy) — the requester's own mailbox** (`jordan@ptpbags.com`). Reuses
  the existing CRM Graph app **as-is; no new Azure setup**. Because auth is app-only, the From
  is **decoupled from who clicked** — a colleague triggering a send still goes out from this
  one mailbox and lands in *its* Sent Items. Accepted as fine for the rehearsal (a little odd
  but harmless); who actually clicked is still recorded in `notifications.triggered_by` (§7).
- **Phase 2 — a dedicated shared mailbox** (`rates@ptpbags.com`). Team sees replies / Sent
  Items, survives staffing changes. Migration is **config-only**: provision the shared
  mailbox, grant the Graph app access to it (scope with an **ApplicationAccessPolicy** so
  `Mail.Send` can't target arbitrary tenant users), then repoint the `sender-mailbox` config.
  No code change.

**Hosting choice:** port the Graph logic into the Edge Function (cleanest boundary, next to
the data / RLS), **or** expose a notification endpoint on the existing CRM backend and have
the app call that (reuses working infra). Either works — pick the lower-friction one.

**Per-forwarder send structure (what the function loops over):**
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

**Alternative trigger (event-sourced):** insert a `notifications` row → **Supabase Database
Webhook** → the same send function. "Insert = send," fully auditable, but more moving parts —
use only if you prefer event sourcing over the direct `invoke`. *(Low-code fallback, not used:
a Power Automate "Send an email from a shared mailbox" flow — only worth it if Graph weren't
already in hand.)*

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
  Microsoft Graph → team. (Naturally batches; mirrors the outbound path.)
- **Recipients:** the shared mailbox / a team distro / all `requester` profiles.
- **Channel:** email; optionally a **Microsoft Teams** post (Graph posts to channels too) since you're in M365.
- *Alternative:* DB webhook on `rate_submissions` insert with debounce — more complex; the
  client-invoke above is simpler and inherently per-action.

## 9. Anti-annoyance / throttling

- Outbound is **manual only**.
- Show **"last notified"** per period; **warn on re-send within a cooldown** (e.g. < 12h).
- Reminders skip already-responded forwarders **by construction** (§3).
- A forwarder with **zero outstanding/relevant lanes is never emailed**.

## 10. Security & config

- **Secrets** (Supabase function env, never client/`VITE_`): Graph **tenant ID / client ID /
  client secret** (or certificate), and the sender mailbox address.
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

- **Phase 1 (rehearsal):** Edge Function + Microsoft Graph; **sends from the requester's own
  mailbox** (reuses the existing CRM Graph app — no new Azure setup); outbound request +
  reminder from Open Requests; audit log; inbound submit → team email. Free-text lanes
  acceptable.
- **Phase 2:** **dedicated shared mailbox** `rates@ptpbags.com` (config-only sender swap +
  ApplicationAccessPolicy); response roster UI on Open Requests; in-app notification center
  (bell reads `notifications`); Teams channel; coverage-aware per-forwarder filtering; digesting.

## 13. Decisions

| Decision | Choice |
|---|---|
| Email transport | ✅ **Microsoft Graph `sendMail`** from an Edge Function, reusing the CRM integration — no Power Automate / no 3rd-party provider |
| Graph auth | **App-only (`Mail.Send`)** + ApplicationAccessPolicy scoped to the shared mailbox *(confirm the CRM app is app-only)* |
| Sender mailbox | **Phase 1: requester's own mailbox** (reuses existing Graph app, no new setup) → **Phase 2: shared** `rates@ptpbags.com` (config-only swap). Stored as Edge Function config. |
| Trigger | **Edge Function via `invoke`** (vs DB-webhook event-sourced) |
| Hosting | Edge Function **or** reuse the CRM backend's Graph endpoint *(open)* |
| Button pattern | **C — hybrid** (fast `Send Rate Request` + `Send Reminder…` modal, shared pipeline) |
| Inbound mechanism | **Client-invoke once per submit** (vs webhook + debounce) |
| Inbound channel | Email now; **Teams** optional later (Graph does both) |
| Reminder content | **Per-forwarder outstanding lanes** (vs same full list) |
