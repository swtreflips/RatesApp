# Alerts & Notifications Model

**Status:** **Phase 1 outbound is BUILT & deployed** (seed → cloud send → Send/Reminder buttons),
June 21, 2026. Inbound (§8), keep-alive cron (§6c), and Phase 2 (app-only / shared mailbox) still
pending. **Created:** June 15, 2026.
**Relates to:** `CLAUDE.md` (Edge Functions for notifications), `PROVIDER_VIEW_MODEL.md`
§6 (response roster), `COVERAGE_MODEL.md` (per-forwarder lane relevance), `MOCKDEPLOY.md`
(M365 tenant + Cloudflare gate).

> **This file has two parts:**
> **Part A — As-Built Record (§0)** — what is *actually deployed* now: the implemented system,
> schemas, files, flows, and the decisions made while building it. Source of truth for the current
> mental/system model.
> **Part B — Design & Planning Spec (§1 onward)** — the original design guidelines. Some is now
> built (see Part A), some is still pending. Where they differ, **Part A wins for "what is,"
> Part B for "why / what's next."**

**Locked decisions / tech stack:** emails are sent **truly from the M365 / Outlook mailbox**
via the **Microsoft Graph API** (`sendMail`), called from a **Supabase Edge Function** —
reusing the Graph integration already built for an internal CRM (Azure app registration,
token flow, and compose/send are solved). The forwarder email is a **short invitation + app
link**, with the lanes delivered as a **filled copy of `PTP OFQ Rates Template.xlsx` attached**
— emulating the current manual rate-request email (§6a). Outbound sending is **manual and
requester-controlled**, never automatic per lane-post. (Power Automate is a low-code fallback
only — **not used here**, since Graph is already wired.)

---

# Part A — As-Built Record (implemented June 21, 2026)

> What is **actually deployed and working** today, plus the decisions taken while building it.
> Part B (§1+) is the original spec. This section is the current system/mental model.

## 0. As-Built

### 0.1 The headline shift — local Python → Supabase + Deno, "everything online"
The send pipeline moved off a local machine entirely. The Python reference (`graph.py`) is now
**seed + reference only**; the runtime lives in Supabase Edge Functions (Deno/TS).

- **The single remaining local + Python step is `python graph.py seed`** — the one-time, interactive
  device-code login (`msal`) that mints the first refresh token. It *cannot* run in an Edge Function.
  After seeding, **every send + token refresh runs in the cloud**, machine-independent (colleagues
  send with your computer off). Re-seed only on session-invalidation events (password/MFA/CA change).
- **Logic reused, code re-implemented.** `graph.py`'s mechanics were ported to Deno: openpyxl→XML
  surgery, `msal/requests` refresh+send→`fetch`, the local `.graph_refresh_token` file→a DB row.
- **Philosophy:** keep the trust boundary in the Edge Function (next to the data/RLS); secrets never
  reach the browser; the client sends IDs, the server resolves everything sensitive.

### 0.2 Outbound template fill — XML surgery, not a spreadsheet library (DECIDED)
The filled `.xlsx` attachment is produced by **direct XML/zip surgery** (`npm:fflate`), **not ExcelJS**.
- **Why:** the template's POD / Last CY / Carrier dropdowns are **x14 extension-list data validations**
  (10 of them, column-wide sqref e.g. `M2:M1048576`). Both ExcelJS *and* openpyxl **drop x14
  validations on re-save**. Surgery writes **only the cell values** into `xl/worksheets/sheet1.xml`
  (as inline strings, so `sharedStrings.xml` is untouched) and leaves every other zip entry
  **byte-for-byte identical** → styles, dropdowns, and the `Validation` sheet survive 100%.
- **Verified:** generated file has all 13 entries preserved, `styles.xml`/`sharedStrings.xml`/
  `Validation` byte-identical, all 10 x14 validations intact; round-trips back through the inbound
  parser; opens clean in Excel with working dropdowns.
- **Inbound stays SheetJS, unchanged.** SheetJS reads an uploaded `.xlsx` → first sheet → CSV (values
  only; styles irrelevant inbound). **No conflict:** SheetJS = read (frontend), fflate surgery =
  write (Edge Function). Two opposite directions.
- **Template delivery = base64-embedded TS** (`templateBytes.ts`), not a bundled binary asset or
  `Deno.readFile` — guaranteed to deploy because it's code. (Supabase Storage is still the §6a
  end-state; deferred.)

### 0.3 Files built this session
| File | Role |
|---|---|
| `supabase/functions/_shared/fillTemplate.ts` | XML-surgery fill (mirrors `graph.py` column map C/D/H/I/L/M/N, rows from 2) |
| `supabase/functions/_shared/templateBytes.ts` | the template, base64-embedded (regenerate from the `.xlsx` if it changes) |
| `supabase/functions/_shared/graph.ts` | shared Graph helpers: `getAccessToken` (refresh+rotate+persist), `sendMail` (multi-recipient), `invitationHtml`, `toBase64` |
| `supabase/functions/send-template/` | **throwaway smoke test** (`--no-verify-jwt`, open endpoint) — RETIRE once confident |
| `supabase/functions/notify-forwarders/` | **the real function** — role-gated; `kind: request \| reminder \| preview` |
| `supabase/migrations/20260621120000_notify_forwarders.sql` | audit tables + flags + recipient resolver |
| `src/features/internal/services/notifyService.js` | client wrapper (`previewNotification` / `sendNotification`) |
| `src/features/internal/components/SendModal.jsx` | shared recipient picker (roster badges, All toggle, cooldown warn) |
| `src/features/internal/pages/OpenRequests.jsx` | **Send Rate Request** + **Send Reminder** buttons + toast |

### 0.4 Schemas added (live on the remote DB)
```sql
-- token store (created earlier, §6c): single row, RLS ON + NO policies → service-role only
graph_credentials(id int pk =1, refresh_token text, updated_at timestamptz)

-- audit log (§7): internal can SELECT; forwarders no access; inserts via service role (bypasses RLS)
notifications(id uuid, kind 'request'|'reminder', triggered_by uuid→auth.users, period int, created_at)
notification_recipients(id, notification_id→notifications, forwarder_id→forwarders,
                        email text /*snapshot, joined*/, lane_count int,
                        status 'queued'|'sent'|'failed', error text, sent_at timestamptz)

-- recipient controls (multi-analyst model)
forwarders.active                boolean default true   -- whole-company on/off (default recipient set)
profiles.receives_rate_requests  boolean default true   -- per-analyst opt-out

-- recipient resolver: SECURITY DEFINER, EXECUTE revoked from public/anon/authenticated,
-- granted to service_role only (auth.users.email never reaches the browser)
get_forwarder_recipients(p_forwarder_ids uuid[]) → (forwarder_id, forwarder_name, email)
  = forwarders(active) ⨝ profiles(receives_rate_requests) ⨝ auth.users(email)
```

### 0.5 Recipient model — DECIDED (fits multi-analyst access)
A forwarder company has **many analysts** (multiple `profiles` sharing `forwarder_id`).
- **Analysts ARE the contacts.** Email = **`auth.users.email`** (their login) — **never duplicated**
  into `profiles`. No separate "contact" column.
- **One email per forwarder**, with **all that forwarder's opted-in analysts** in `toRecipients`.
- **Two control knobs:** `forwarders.active` (company) and `profiles.receives_rate_requests`
  (analyst). Today these are **set via SQL / Table Editor — no in-app UI yet** (a future
  "Recipients" admin screen is the natural next slice).

### 0.6 Token lifecycle (as-built)
1. **Seed (local, once):** `graph.py seed` → device-code login as `luismht@` → upsert the refresh
   token into `graph_credentials` (id=1).
2. **Per send (cloud):** function reads the row → POST `{tenant}/oauth2/v2.0/token`
   (`grant_type=refresh_token`, no secret) → gets `access_token` + a **rotated** `refresh_token` →
   **persists the rotated token back** to the row. That rotation-persistence *is* the keep-alive.
3. **Fail-loud:** a non-200 grant (≈90-day lapse / MFA / CA change) throws a clear "re-seed required"
   error rather than failing silently.
4. **Keep-alive cron — NOT YET BUILT** (§6c/§15.4): a weekly `pg_cron` refresh-only run is still
   pending. Until then, the chain stays alive only through regular sends.

### 0.7 notify-forwarders — system flow (as-built)
```
Browser (internal user, Open Requests)
  supabase.functions.invoke('notify-forwarders', { kind, forwarderIds?, period? })   // IDs only, never emails
        │  (supabase-js auto-attaches the user's JWT)
        ▼
Edge Function notify-forwarders (Deno, deployed WITH jwt verification)
  0. CORS preflight (OPTIONS) handled + CORS headers on every response   ← required for browser calls
  1. ROLE-GATE: getUser() from the caller's JWT → require profiles.role = 'internal'  (else 401/403)
  2. service-role client: forwarder set (explicit ids, else all active)
  3. recipients = rpc('get_forwarder_recipients', ids) → emails grouped per forwarder
  4. open lanes (expires_at > now) + all rate_submissions acks → outstanding anti-join
  5a. kind='preview'  → return roster {responded/skipped/outstanding/recipientCount/lastNotifiedAt}; SEND NOTHING
  5b. kind='request'  → lanes per forwarder = ALL open lanes
      kind='reminder' → lanes per forwarder = OUTSTANDING only (no ack for (forwarder,lane,period))
      → token step (0.6) → per forwarder: fillTemplate → sendMail(all analyst emails)
      → insert notifications + notification_recipients (sent/failed per forwarder)
  6. return { sent, failed }
        ▼
login.microsoftonline.com (token)  +  graph.microsoft.com/me/sendMail → Outlook (luismht@) → forwarders
```
- **"Who responded" is derived from `rate_submissions`** (the anti-join), **never** from the audit
  log. `notifications` is audit / "last notified" / future bell only (§7).
- **Reminder correctness falls out for free:** a forwarder who answered everything has 0 outstanding
  → skipped; a mid-period new lane reappears for anyone who hasn't quoted it (§14).
- The **modal is driven by `kind:'preview'`** — counts only, no emails ever sent to the browser.

### 0.8 Security posture (as-built vs §16)
- ✅ Client sends `forwarderIds` only; emails resolved server-side (`get_forwarder_recipients`,
  service-role-only). Browser never holds the recipient list or the token.
- ✅ `notify-forwarders` is **role-gated + deployed with JWT verification**.
- ✅ Refresh token in the locked `graph_credentials` row (RLS on, no policies); service-role key only
  in the Edge env (auto-injected); never `VITE_`, never logged.
- ⚠️ **`send-template` is still deployed `--no-verify-jwt` = an open mail-sending endpoint.**
  **Action: delete it** (`supabase functions delete send-template`) once `notify-forwarders` is trusted.

### 0.9 Ops / deploy model (learned this session)
- **Two independent deploys:** (a) **Edge Functions** → `npx supabase functions deploy <name>` (to
  Supabase); (b) **frontend** → `git push main` → **Vercel**. A git push does **not** deploy functions,
  and a function deploy does **not** touch the app.
- **DB changes:** `npx supabase db push` (or paste SQL in the editor). Remote push needs **no Docker**
  (the Docker warning only affects an optional local catalog cache).
- **Three separate config stores — do not conflate:** Vercel `VITE_*` (frontend, public) ·
  Edge `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (auto-injected) · Edge secrets
  `MS_TENANT_ID`/`MS_CLIENT_ID`/`SENDER_NAME`/`APP_URL` (`supabase secrets set`).
- **Toolchain:** Supabase CLI = npm dev-dep (`npx supabase`); Deno installed for local typecheck/test.
  This CLI (v2.107) has **no `functions invoke`** → invoke functions over HTTP (`curl`) or from the app.
- **CORS:** any browser-invoked function must answer the `OPTIONS` preflight and return
  `Access-Control-Allow-*` headers (added to `notify-forwarders`; was the cause of the first
  "Failed to send a request to the Edge Function" error).

### 0.10 Still open (tracked in Part B)
- Retire `send-template` (0.8). · Keep-alive `pg_cron` (0.6 / §6c). · In-app recipient management UI
  (0.5). · Inbound `notify-submission` (§8). · Phase 2: app-only `Mail.Send` + shared `rates@` mailbox
  (§6c/§13). · Coverage-aware lane filtering (§11 / `COVERAGE_MODEL.md`).

---

# Part B — Design & Planning Spec

> The original design guidelines (predates the build). Cross-check against Part A for current state.

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

**Keep-alive — Supabase cron (DECIDED).** A scheduled function (**pg_cron**) runs the **same
refresh-token grant every 7 days, server-side**, and updates the `graph_credentials` row —
entirely in the cloud. This is a **non-interactive keep-alive refresh, NOT the interactive
device-code re-seed**, so it runs unattended with **no dependency on anyone's machine**:
colleagues use the Edge Function to send requests/reminders anytime, your computer off.

- **Covers:** the ~90-day **inactivity** lapse — eliminated. (Sends already refresh+persist
  on each ~10-day send; the cron just bulletproofs longer quiet stretches.)
- **Does NOT cover:** **session-invalidation events** — password change, MFA re-registration,
  conditional-access change, admin revoke. These kill the token regardless of refreshing and
  need a **one-time interactive `python graph.py seed`** (rare, event-driven; the fail-loud
  surfaces it). This is the accepted cost of staying delegated; **Phase-2 app-only** removes
  even this (no user session → nothing to invalidate).
- **Concurrency note:** if the cron and a send fire together, both consume + rotate the token;
  Entra tolerates a brief reuse window, so the race is low-risk at this scale — keep the
  `graph_credentials` row the single source of truth.

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

## 6d. Edge Function flow — running `graph.py`'s logic on Supabase

`graph.py` stays the **local seed + reference**; the runtime is just its two HTTP calls ported to
`fetch` inside a Deno Edge Function, with the token moving from the local `.graph_refresh_token`
file to the `graph_credentials` DB row. **`msal` is only for the one-time seed — never at runtime.**

```
A. SEED (local, once)
   python graph.py seed  ──(msal device-code login as luismht@)──►  refresh_token
        └──────────────── upsert into ──────────────►  graph_credentials row

B. SEND (per click)                                    C. KEEP-ALIVE (scheduled)
   browser ─ invoke('notify-forwarders',{…}) ─┐         pg_cron every 7 days
                                               ▼              │ pg_net
   ┌──────────────────────────────────────────────────┐      ▼
   │ Edge Function notify-forwarders (Deno)             │   (refresh-only run of step ③)
   │  ① verify JWT + role='internal'                    │
   │  ② service-role queries: emails, outstanding lanes │
   │  ③ TOKEN  read graph_credentials.refresh_token ◄─┐ │ ◄─── same row, same ③
   │     POST {tenant}/oauth2/v2.0/token (refresh)    │ │
   │     → access_token + ROTATED refresh_token       │ │
   │     UPDATE graph_credentials = rotated ──────────┘ │   (persist = keep-alive)
   │  ④ per forwarder: build .xlsx (SheetJS) +          │
   │     POST graph.microsoft.com/v1.0/me/sendMail      │
   │  ⑤ INSERT notifications / notification_recipients  │
   │  ⑥ return { sent, failed }                         │
   └───────────────┬─────────────────────┬──────────────┘
                   ▼                      ▼
        login.microsoftonline.com   graph.microsoft.com/me/sendMail
        (token endpoint)                  └─► Outlook/M365 (luismht@…) ─► forwarders
```

Every actor — your send, a colleague's send, the cron — does the same **read → refresh → write
rotated** on the one `graph_credentials` row. That rotation persistence *is* the keep-alive (§6c).

| `graph.py` (local) | Edge Function (Deno) |
|---|---|
| `seed_refresh_token()` (msal) | — stays local, one-time → upsert into `graph_credentials` |
| `load/save_refresh_token()` (file) | `select` / `update graph_credentials` (service role) |
| `get_access_token()` | step ③ — `fetch` token endpoint + persist rotated token |
| `fill_template()` (openpyxl) | SheetJS (`xlsx`, already used in the frontend) |
| `send_mail()` | step ④ — `fetch` `/me/sendMail` (same payload) |
| `refresh_token_keepalive()` | the **pg_cron** job (refresh-only) |

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
| Token keep-alive | ✅ **Supabase `pg_cron` every 7 days** runs the refresh-grant + updates `graph_credentials`, server-side (machine-independent). Manual re-seed **only** on session-invalidation events (§6c) |
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


Next steps toward the full feature, whenever you're ready, are the ones in ALERTS.md — porting this to the notify-forwarders Edge Function, the graph_credentials row + pg_cron keep-alive, and the Send/Reminder buttons in the app.

## 15. Implementation action plan — from `graph.py` to deployed

**Where I am now:** `graph.py seed` works locally (refresh token in `.graph_refresh_token`);
`send-template` and `refresh` work; the token rotates on use. Supabase project + app tables are
live. Goal: move that exact logic into a Supabase Edge Function with a DB-stored, self-renewing
token (§6c/§6d). No new host, no Azure changes.

1. **DB — token store + audit tables** *(Supabase SQL editor).* Create `graph_credentials`
   (single row; RLS on, **no policies** → service-role only — §6c) and `notifications` /
   `notification_recipients` (§7).
2. **Upsert the seeded token** *(one-time).* Take the value from local `.graph_refresh_token` and
   put it in the row:
   ```sql
   insert into graph_credentials (id, refresh_token) values (1, '<paste from .graph_refresh_token>')
   on conflict (id) do update set refresh_token = excluded.refresh_token, updated_at = now();
   ```
   *(Optional later: a `graph.py push-token` command that upserts via the Supabase REST API instead
   of pasting — needs the project URL + service-role key locally.)*
3. **Edge Function `notify-forwarders`** *(Deno/TS; `supabase functions deploy`).* Port the §6d
   steps: role-gate → resolve emails + outstanding lanes (service role) → **token step ③**
   (read row → `fetch` refresh grant → `update` rotated token) → per forwarder fill `.xlsx`
   (SheetJS) + `fetch` `/me/sendMail` → write audit rows. **Secrets:** `MS_TENANT_ID`,
   `MS_CLIENT_ID`, `APP_URL` (the service-role key is injected into Edge Functions automatically).
4. **Keep-alive cron.** A **refresh-only** path (e.g. `notify-forwarders` with `kind:'refresh'`, or
   a tiny `graph-keepalive` function) scheduled via **`pg_cron` + `pg_net` every 7 days** to run
   token step ③ with no send (§6c).
5. **App wiring.** Add `Send Rate Request` / `Send Reminder…` on Open Requests (§4 Option C) →
   `supabase.functions.invoke('notify-forwarders', { kind, forwarderIds, period })`.
6. **Verify.** Invoke a send → email arrives from `luismht@…`; confirm `graph_credentials.refresh_token`
   **changed** (rotation); run the cron manually → token refreshes, no send; re-send still works
   (chain alive). Then the §5 isolation/round-trip checks.
7. **Phase 2 (later).** Swap delegated → **app-only `Mail.Send` + shared `rates@` mailbox**
   (client secret/cert, ApplicationAccessPolicy) — config-only on the sender, removes the re-seed
   need entirely (§6/§13).

**Critical path:** 1 → 2 → 3 (the core slice: a real send from the cloud) → 4 (don't let the token
lapse) → 5 (UI) → 6. Steps 1–4 can be proven before any UI exists by invoking the function directly.

## 16. Security — protecting the Graph token & the Supabase account

Expands §10. Two assets carry almost all the risk here:

- **The Graph refresh token** — long-lived; whoever holds it can **send email as `luismht@`**
  (`Mail.Send`, *delegated* → scoped to that **one mailbox**, not the whole tenant). A leak =
  someone phishing/impersonating from your address. Lives in `graph_credentials` (and, in dev,
  `.graph_refresh_token`).
- **The Supabase service-role key** — **bypasses RLS** → full DB read/write (including the token
  row). Lives only in the Edge Function env.

Both are **server-side only** and **must never reach the browser**.

### Framework — how this class of system is normally secured
1. **Least privilege.** Request the **minimum Graph scope** (`Mail.Send` only — not full-mailbox).
   Phase 2 app-only adds an **ApplicationAccessPolicy** pinning the app to a single mailbox so it
   can't send as arbitrary tenant users. The Edge Function holds the service role, but **every
   invocation is role-gated**.
2. **Secrets never client-side.** Refresh token, service-role key, (Phase-2) client secret →
   Edge Function env / locked DB row. **Never** a `VITE_` var, never in the repo, never in the
   bundle. (The anon key is public *by design*; RLS is the real boundary.)
3. **Token at rest.** `graph_credentials` has **RLS on + no policies** (service-role only). Harden
   further by **encrypting the column** (Supabase **Vault** / pgsodium) so a DB dump or backup
   leak doesn't expose a usable token.
4. **The Edge Function is the trust boundary.** It must: (a) verify the caller's **JWT + role**
   before anything; (b) **resolve recipient emails server-side** from your own `forwarders`/
   `profiles` — **never accept raw addresses from the client** (so it can't be abused as an open
   relay); (c) read the token with the service role only *after* auth-gating; (d) **never log or
   return** tokens.
5. **Short access tokens + rotation.** Access tokens last ~1h; the refresh token **rotates on
   every use** and the prior one dies — so a stale leaked token self-expires (also the keep-alive
   mechanic, §6c).
6. **Transport.** Everything over HTTPS (Graph, Supabase); no secrets in URLs or logs.
7. **Audit + monitor.** The `notifications` log records **who triggered** each send
   (`triggered_by`) — accountability. Watch the mailbox's **Sent Items** + Supabase function logs
   for anomalies.
8. **Account hygiene (the real perimeter).** **MFA on**: the `luismht@` M365 account, the
   **Supabase** account, and the **GitHub** account (pushes auto-deploy to Vercel). Limit who holds
   the service-role key, the Supabase dashboard, and the Azure app-registration.
9. **Abuse limiting.** A compromised *internal* user could blast email from your domain
   (reputational/phishing risk). The **cooldown** (§9) + role-gate + audit log + a hard per-period
   cap contain the blast.

### For YOUR flow — concrete checklist while building
- [ ] `graph_credentials`: RLS **enabled**, **no policies** (service-role only); consider Vault
  encryption on `refresh_token`.
- [ ] `.graph_refresh_token` stays **gitignored** (done); never commit/paste it publicly; treat the
  seed machine as sensitive.
- [ ] Edge Function: first lines = **verify JWT + `profiles.role='internal'`**; reject otherwise.
- [ ] Client sends **`forwarderIds`**, never email strings; the function resolves addresses itself.
- [ ] Service-role key: only the Edge Function env (auto-injected) — **never** app/`VITE_`/repo.
- [ ] Keep-alive: callable only by **pg_cron / service role**, not anonymous HTTP.
- [ ] No secret in any `console.log` / error response.
- [ ] Per-period send cap + cooldown (§9).

### Break-glass / revocation (know this *before* go-live)
- **Token compromised** → Entra: **revoke sign-in sessions** for `luismht@` (invalidates the
  refresh token) + reset password → re-seed (`graph.py seed`) → upsert the new token (§15.2).
- **Service-role key compromised** → rotate it in Supabase → update the Edge Function env.
- **Supabase / GitHub account compromised** → rotate keys, review recent deploys, check the audit
  log + Sent Items.
- **Phase 2 improves posture:** an app-only token (no human session to hijack) + a
  **rotatable/expiring client secret or certificate** + ApplicationAccessPolicy scoping — plan that
  migration before scaling beyond the rehearsal.