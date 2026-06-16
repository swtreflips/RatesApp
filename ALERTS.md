# Alerts & Notifications Model

**Status:** Design spec. **Not implemented.** Build during/after the MOCKDEPLOY rehearsal.
**Created:** June 15, 2026
**Relates to:** `CLAUDE.md` (Edge Functions for notifications), `PROVIDER_VIEW_MODEL.md`
§6 (response roster), `COVERAGE_MODEL.md` (per-forwarder lane relevance), `MOCKDEPLOY.md`
(M365 tenant + Cloudflare gate).

**Locked decisions / tech stack:** emails are sent **truly from the M365 / Outlook mailbox**
via the **Microsoft Graph API** (`sendMail`), called from a **Supabase Edge Function** —
reusing the Graph integration already built for an internal CRM (Azure app registration,
token flow, and compose/send are solved). The forwarder email is a **short invitation + app
link**, with the lanes delivered as a **filled copy of `PTP OFQ Rates Template.xlsx` attached**
— emulating the current manual rate-request email (§6a). Outbound sending is **manual and
requester-controlled**, never automatic per lane-post. (Power Automate is a low-code fallback
only — **not used here**, since Graph is already wired.)

---

## 1. Two directions

| Dir | From → To | Trigger | "Here is…" |
|-----|-----------|---------|------------|
| **Outbound (demand)** | requester → forwarders | **manual button** | the lanes we need rates for (attached rate-request sheet) |
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

This computed lane set **is exactly the rows written into that forwarder's attached
spreadsheet** (§6a). So **a lane added mid-period simply appears in the next send to every
forwarder who hasn't quoted it** — there is no separate "small batch" flow (§14).

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
   │  • composes the invitation email + generates the filled .xlsx attachment (§6a)
   │  • calls Microsoft Graph /me/sendMail with the attachment (delegated token — §6c)
   ▼
Microsoft Graph   POST /v1.0/me/sendMail   (Phase 1 — delegated)
   ▼
Outlook / M365 (Phase 1: seeded mailbox luismht@… · Phase 2: shared rates@ptpbags.com) → forwarders
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

**Auth (Phase 1) = delegated, reusing the existing CRM app via a stored refresh token.** The
CRM Graph app is a **public client** (device-code flow, sends as `/me`) — confirmed by inspecting
`auth.py` / `send.ipynb`. Rather than stand up app-only auth, we **seed its refresh token once**
(the existing device flow) and the Edge Function mints access tokens from it per send
(refresh-token grant — no client secret), sending as the requester's own mailbox via
`/me/sendMail`. Mechanics + seeding in **§6c**. **Phase 2** swaps to **app-only (`Mail.Send`) +
the shared mailbox** for a durable, stateless server send (the one-time Azure secret + admin
consent lands then).

**Sender mailbox — phased, and a config value (not hardcoded).** The target is
`POST /users/{sender-mailbox}/sendMail`, where `{sender-mailbox}` is an Edge Function
**config/secret** so it changes with **zero code edits**:

- **Phase 1 (initial deploy) — the seeded mailbox** (`luismht@primetimepackaging.com`). Reuses
  the existing CRM Graph app **as-is; no new Azure setup**. Because the function sends with **one
  stored refresh token** (not the clicker's identity), the From is **decoupled from who clicked**
  — a colleague triggering a send still goes out from this one mailbox and lands in *its* Sent
  Items. Accepted as fine for the rehearsal (a little odd but harmless); who actually clicked is
  still recorded in `notifications.triggered_by` (§7).
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

## 6a. Email composition — invitation + Excel attachment

The lanes are **not** listed in the body. The email mirrors today's manual rate-request mail:
a short invitation, and the lanes ride along as a **filled copy of the standard template**.

**Body** — a short, parameterized invitation + the **app link**, asking them to return rates
by **uploading the completed sheet** or **entering them in the app**, plus the **direct vs
transshipment** ask. Seed copy:

> Hello {forwarder},
>
> Attached is the rate request with the lanes we need quoted for this period. Please complete
> the sheet (rate, carrier, port of discharge, last CY, free days…) and indicate whether each
> shipment is **direct or involves a transshipment**.
>
> Return your rates by uploading the completed sheet in our portal, or entering them directly:
> {appUrl}
>
> Thanks,
> {sender}

**Attachment** — a filled copy of `PTP OFQ Rates Template.xlsx`. The template's 19 columns
(A–S, two sheets: `Sheet1` data + a `Validation` sheet driving the POD/Last-CY/carrier
dropdowns) split along the requester→forwarder line. The function writes the **requester**
columns from each lane (data rows start at **row 2**) and leaves the **forwarder** columns
blank:

| Col | Header | Filled from |
|---|---|---|
| C | Port of Loading | `lane.pol` |
| D | Final Destination | `lane.fd` |
| H | Container Type | `lane.container_type` |
| I | # of Containers | `lane.container_count` |
| L | Forwarder | recipient's company name (attribution convenience) |
| M | Port of Discharge | `lane.pod` **if the requester set it**, else blank (overridable) |
| N | Last CY/CFS | `lane.last_cy` **if set**, else blank (overridable) |
| A, B, E, F, G | Internal ID, ID, Cargo Ready Date, Incoterm, PO(s) | **blank (deferred — §11)** |
| J, K, O–S | Rate/Unit, Date Received, Vessel ETD/ETA, Last CY/CFS ETA, # Free Days, Carrier | blank (forwarder fills) |

**Library = ExcelJS** — load the template, write rows, `writeBuffer`. It preserves the
template's styles **and** the `Validation` sheet's data-validation dropdowns on round-trip.
*(SheetJS community edition drops styles on write — unsuitable for "looks like our template.")*
Verify dropdowns / print area / formatting survive in Excel.

**Template storage = Supabase Storage** (e.g. a `templates` bucket). The function fetches the
canonical `.xlsx`, fills it, attaches it — so updating the template is **data-only, no
redeploy**. (`PTP OFQ Rates Template.xlsx` currently sits untracked in the repo root → move it
to Storage.)

**Graph attachment** — `#microsoft.graph.fileAttachment` with base64 `contentBytes`,
`contentType: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, and
`name: "PTP OFQ Rates - {Forwarder} - {YYYY-MM-DD}.xlsx"`. Generated **per recipient** (lane
subsets differ), in the Edge Function (Deno + ExcelJS via `npm:`) or the CRM backend (same open
hosting choice as §6).

## 6b. Round-trip — one template, both directions

The attachment's **forwarder columns (J–S)** are the same fields the provider grid captures, so
the planned **provider `.xlsx` upload** (NEXTSTEPS G4) should **parse this exact template**: a
forwarder fills the attached sheet and uploads it straight back, or enters rates manually. One
template out, the same template in. *(Replying by email with the sheet is a legacy habit during
transition; the email link steers them to the app as the return path.)*

## 6c. Graph integration — extracted from the internal CRM (Phase 1)

Reused from the existing Graph project (`auth.py`, `send.ipynb`, `followup.ipynb`). It's a
**delegated public-client** app (device-code flow, token cache), so the Edge Function reuses it
via a **stored refresh token** rather than interactive login.

**Variables**

| Name | Value |
|---|---|
| `client_id` | `d4a32e7f-44b5-472b-9a4b-bdfd0c43a61f` |
| `tenant_id` | `cc38fec1-5ec4-40bd-985a-4855a2ba4372` |
| authority | `https://login.microsoftonline.com/{tenant_id}` |
| sender (Phase 1) | `luismht@primetimepackaging.com` |
| scopes | `Mail.Send offline_access` *(+ `Mail.ReadWrite` only for draft-then-send / in-thread reply)* |

**Seeding (one-time, local)** — reuse `auth.py`'s device flow with `scopes=["Mail.Send"]`; after
`acquire_token_by_device_flow`, read `cache.serialize()` JSON and extract the **RefreshToken**
secret. Store it in a locked single-row table (service-role only):

```sql
create table graph_credentials (
  id            int primary key default 1,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);
alter table graph_credentials enable row level security;  -- no policies → only service_role reaches it
```

**Per-send token (in the function)** — refresh-token grant (public client → **no secret**):

```
POST https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token
  grant_type=refresh_token & client_id={client_id}
  & refresh_token={row.refresh_token} & scope=Mail.Send offline_access
→ { access_token, refresh_token }   ← PERSIST the rotated refresh_token back to the row
```

Entra rotates the refresh token on each use; persisting it keeps the chain alive. A ~90-day
lapse, MFA, or conditional-access change still invalidates it → the function must **fail loudly**
so the token can be re-seeded.

**Send call** (adds HTML body + the `.xlsx`, which the CRM code lacks):

```
POST https://graph.microsoft.com/v1.0/me/sendMail
{
  "message": {
    "subject": "Rate Request — Period {n}",
    "body": { "contentType": "HTML", "content": "<the §6a invitation>" },
    "toRecipients": [ { "emailAddress": { "address": "silvia@…" } } ],
    "attachments": [ {
      "@odata.type": "#microsoft.graph.fileAttachment",
      "name": "PTP OFQ Rates - Tanera Transport - 2026-06-16.xlsx",
      "contentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "contentBytes": "<base64 xlsx>"
    } ]
  },
  "saveToSentItems": true
}
→ 202
```

*(Optional in-thread reminders: switch to draft-then-send `POST /me/messages` → capture
`conversationId` → `createReply`, mirroring `followup.ipynb`.)*

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
--   (audit-only — NOT needed to drive sends; see §14)
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

- **Secrets** (Supabase function env, never client/`VITE_`): `MS_TENANT_ID`, `MS_CLIENT_ID`,
  `APP_URL`. The **Graph refresh token** lives in the locked `graph_credentials` DB row (not env)
  so the function can persist Entra's rotation (§6c). *(Phase 2 app-only swaps these for a client
  secret/cert.)*
- **Role-gate** every notify function (JWT + `profiles.role`).
- `src/lib/constants.js` (planned in NEXTSTEPS A0): `REMINDER_COOLDOWN_HOURS`, sender
  display name; team recipients live in DB or config.

## 11. Edge cases

- Lane **expires between compose and send** → function re-validates active lanes at send time.
- Forwarder **missing email / inactive** → skip + flag in the log.
- **Coverage** (future, `COVERAGE_MODEL.md`): subtract coverage-excluded lanes from a
  forwarder's set; a forwarder covering none of the open lanes drops out. The
  "lanes-per-forwarder" model already accommodates this as one more predicate.
- **Partial send failures** → per-recipient `status='failed'` + `error`; surface in the UI with retry.
- **M365 limits** (~30 msgs/min, ~10k recipients/day) — ample at this scale; mind the loop if
  forwarder counts grow large.
- **Template request fields not yet modeled** (Cargo Ready Date, Incoterm, PO(s), Internal
  ID/ID) ship **blank** in the attachment; add to `rate_request_lanes` later only if forwarders
  need them.
- **Direct vs transshipment** has **no dedicated template column** today — the forwarder notes
  it in a remark. Open question whether to add a structured column (would touch the template
  *and* the rates model).
- **ExcelJS round-trip** may drop exotic template features — verify dropdowns / print area /
  formatting in Excel before relying on the generated file.

## 12. Phasing

- **Phase 1 (rehearsal):** Edge Function + Microsoft Graph; **sends from the seeded mailbox via a
  stored refresh token** (reuses the existing CRM Graph app — no new Azure setup, §6c); outbound
  request + reminder from Open Requests; audit log; inbound submit → team email. Free-text lanes
  acceptable.
- **Phase 2:** **dedicated shared mailbox** `rates@ptpbags.com` (config-only sender swap +
  ApplicationAccessPolicy); response roster UI on Open Requests; in-app notification center
  (bell reads `notifications`); Teams channel; coverage-aware per-forwarder filtering; digesting.

## 13. Decisions

| Decision | Choice |
|---|---|
| Email transport | ✅ **Microsoft Graph `sendMail`** from an Edge Function, reusing the CRM integration — no Power Automate / no 3rd-party provider |
| Email format | ✅ **Invitation + app link in body; lanes as an attached filled `.xlsx` template** (§6a) — not inline |
| Excel library | **ExcelJS** (preserves template styles + validation dropdowns) |
| Template storage | **Supabase Storage** (`templates` bucket; data-only updates) |
| Batch handling | **Full outstanding per forwarder** — no special subsequent/single-batch path (§14) |
| Extra template fields | **Blank for now** (Cargo Ready Date / Incoterm / PO(s) / Internal ID deferred) |
| Graph auth | **Phase 1: delegated refresh-token** reusing the CRM public-client app (`client_id d4a32e7f…` / `tenant cc38fec1…`), no Azure changes (§6c) → **Phase 2: app-only (`Mail.Send`)** + ApplicationAccessPolicy |
| Sender mailbox | **Phase 1: seeded** `luismht@primetimepackaging.com` (sends via `/me`) → **Phase 2: shared** `rates@ptpbags.com` (config-only swap) |
| Trigger | **Edge Function via `invoke`** (vs DB-webhook event-sourced) |
| Hosting | Edge Function **or** reuse the CRM backend's Graph endpoint *(open)* |
| Button pattern | **C — hybrid** (fast `Send Rate Request` + `Send Reminder…` modal, shared pipeline) |
| Inbound mechanism | **Client-invoke once per submit** (vs webhook + debounce) |
| Inbound channel | Email now; **Teams** optional later (Graph does both) |
| Reminder content | **Per-forwarder outstanding lanes** — same rule as every send (§14) |

## 14. Batch handling — initial vs subsequent vs single

**There is no separate path for subsequent, smaller, or single-lane batches.** Because every
send is **"full outstanding per forwarder"** (§3), new lanes flow into the next send
automatically: a lane added mid-period appears in the next send to every forwarder who hasn't
quoted it, while forwarders who already quoted the earlier lanes only see the new ones.

The requester controls **when** (the manual button) and **to whom** (recipient selection, §4);
the **lane content is derived, not hand-picked.** "Initial request" vs "reminder" is purely the
email copy/subject — the lane logic is identical.

**Consequence:** no per-lane "notified" flag is needed — outstanding is derived from
`rate_submissions` acks — so the optional `notification_lanes` snapshot (§7) stays audit-only.

*Optional future:* a "select specific lanes" override for the rare targeted send (e.g. "just
these 3 to everyone now"), layered on top without changing the default.
