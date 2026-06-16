# NEXTSTEPS v2 — Road to the Mock Deployment

**Status:** Current roadmap. **Supersedes `NEXTSTEPS.md`** (June 11), whose "STEP 0 is next"
framing is stale — STEP 0 (live DB + RLS + auth + the real read/write loop) is **done**
(`MEMORY.md` §2–§5).
**Created:** June 16, 2026
**Relates to:** `ALERTS.md` (notifications), `MOCKDEPLOY.md` (deploy runbook + smoke test),
`COVERAGE_MODEL.md`, `MEMORY.md` (as-deployed schema/RLS).

---

## Where we are

Mid **Stage 3** ("build features for real"). Live Supabase (company-keyed `forwarders` model),
RLS, password login, and the full requester↔provider loop run on real data. The notification
layer is **designed** (`ALERTS.md`) with a runnable send reference (`graph.py`), but not built.
Not started: notification build, custom domain, Cloudflare Zero Trust, magic link, hardening.

## The sequence (your call, refined)

```
A. Build + test ALERTS  →  B. Domain + Cloudflare ZT  →  C. Magic-link auth
   →  D. Mock rehearsal (you + colleagues)  →  E. Harden  →  F. Onboard real forwarders
```

> **Key dependency to internalize:** an alert's value is the **app link** forwarders click to
> submit. That link lands on the **gated** app (Cloudflare + magic link) and assumes the
> **provider `.xlsx` upload exists**. So "Alerts" only *fully* closes the loop after B, C, and
> the upload are done. Build the **send** early (it's testable in isolation via `graph.py`),
> but treat the round-trip as gated on B/C + upload.

---

## A. Build + test ALERTS

- **A1 — Validate the send in isolation (do now).** Run `graph.py seed` once, then
  `python graph.py test-send you@…` → confirm a real email arrives from `luismht@…` with the
  filled `.xlsx`, dropdowns intact. This de-risks the whole transport before any Edge Function.
- **A2 — Backend prerequisites.** Add `notifications` + `notification_recipients` (`ALERTS.md`
  §7) and `graph_credentials` (§6c); move `PTP OFQ Rates Template.xlsx` into Supabase Storage.
- **A3 — Port the send to a Supabase Edge Function** (`notify-forwarders`, Deno/TS) mirroring
  `graph.py`: refresh-token grant (+rotation persist), **ExcelJS** fill, `/me/sendMail`,
  audit-log writes, requester role-gate. **Outstanding-per-forwarder must key on
  `forwarder_id`** (company), per `MEMORY.md`.
- **A4 — UI:** `Send Rate Request` / `Send Reminder…` buttons on Open Requests, result toast,
  and the **"last notified" + cooldown** guard (§9) so re-sends don't spam.
- **A5 — Inbound** (`ALERTS.md` §8): on provider submit, one `notify-submission` → team email.

## B. Custom domain + Cloudflare Zero Trust
`MOCKDEPLOY.md` §5/§7. Add the domain in Vercel, proxied CNAME in Cloudflare, a ZT Access app
+ Allow policy for the 3 emails. **Decide the Vercel raw-URL exposure** (`MOCKDEPLOY.md` §9):
Pro deployment-protection to fully gate, or accept the public `*.vercel.app` (RLS still
protects, login-only).

## C. Magic-link auth
`MOCKDEPLOY.md` §2 + `NEXTSTEPS.md` A1. Swap `signInWithPassword` → `signInWithOtp` + a "check
your email / completing sign-in" state; set Supabase **Site URL + Redirect URLs** (localhost +
prod domain) — magic links **fail silently** if the return URL isn't allowlisted.

## D. Mock rehearsal (you + colleagues)
Execute `MOCKDEPLOY.md` §10 smoke test: end-to-end loop (post → alert → forwarder submits →
requester sees) **and** the isolation check (one forwarder cannot see another's rates) **and**
the edge checks (CF gate, raw-URL behavior).

## E. Harden before outsiders *(insert before F — see assessment #4)*
Cross-role **route guards**; **env-gate the dev role toggle** off; **re-verify RLS isolation**
with two real forwarder accounts (the premise of the whole app); decide on **coverage masking**
(#6). Add **custom SMTP** for Supabase auth email if onboarding more than a few users.

## F. Onboard real forwarders
`MOCKDEPLOY.md` §8 data-only flip: insert `forwarders` row → Supabase auth user (+
`profiles`) → add email to Cloudflare Access. No code/schema/redeploy.

---

## Assessment — what you might be overlooking

**1. The two-gate friction — but it's first-time, not per-submit.** A forwarder must pass
**Cloudflare ZT *and* Supabase magic link** before they can submit. The important nuance:
**both are persistent sessions**, so the two-email dance is concentrated at **first contact**,
not every visit.

- **Cloudflare ZT** issues a session cookie whose lifetime is a setting on the Access app
  ("Session Duration," up to **1 month**). One-time-PIN needs no account.
- **Supabase magic link** stores the session in **localStorage** and **auto-refreshes**
  silently (`persistSession` + `autoRefreshToken`, both default on). A *new* magic link is only
  needed for a genuinely new login; otherwise the user stays signed in for weeks.

So with long session durations, most forwarders see the gates **once**; after that the
invitation link just opens the app.

**The real recurring-friction case is your periodic cadence + privacy browsers.** Rate requests
come every ~10 days, and **Safari's ITP evicts localStorage after ~7 days of no interaction** —
so a forwarder who uses **Safari** and only visits once per period can have their Supabase
session evicted between periods → a fresh magic link each time. Chrome/Edge/Firefox survive
this fine. For frequent users it's truly one-time; for infrequent Safari users it can recur.

**Options (decide deliberately):**

1. **Tune sessions long + accept the first-time cost (recommended baseline).** CF Access
   session = 1 month; keep Supabase persist/auto-refresh; never force re-login. Most forwarders
   (Chrome/Edge) then hit the gates ~once. Lowest effort, keeps both security layers.
2. **Drop Cloudflare for forwarders; keep it for the internal team.** CF's only job is keeping
   *strangers* off the app — but you *want* forwarders on it. Gate only the requester/internal
   surface with CF and let forwarders rely on **Supabase magic link + RLS** (RLS is the real
   data boundary; CF is just reachability). Removes a whole gate for forwarders → one email, one
   session. Slightly less defense-in-depth, but RLS still fully isolates each forwarder's
   pricing. **Strong candidate** given adoption is the goal.
3. **Email / upload-back as the no-gate fallback.** For a first period or a stubborn forwarder,
   they fill the Excel and reply by email; you upload it. Zero gates, familiar flow, with app
   submission as the upsell once they're comfortable.

**Recommendation:** Option 1 as the baseline, but seriously weigh **Option 2** — gating
forwarders behind Cloudflare buys little (RLS already protects the data) while adding the exact
friction in question. Keep Option 3 as the graceful fallback. (Still tied to #2: the app return
path needs the `.xlsx` upload built either way.)

**2. The return path isn't built.** `ALERTS.md` §6b assumes forwarders **upload the filled
template back**, but provider upload is **CSV-only** today and doesn't parse *this* template's
columns. If you send the `.xlsx` and expect upload-back, that half of the loop is missing — add
**`.xlsx` upload** (SheetJS) that reads the template's forwarder columns (J–S), or accept manual
entry / email-back for the rehearsal.

**3. Alert recipient = login identity — RESOLVED (non-issue at this scale).** You onboard the
**specific person who handles rate quoting** at each forwarder as that forwarder's login, so
their `profiles` email *is* the rate-desk inbox. Resolving recipients from `profiles`/
`auth.users` is correct; **no `forwarders.contact_email` needed.** Revisit only if a forwarder
ever has **multiple analysts** (the company-keyed model allows it — `MEMORY.md` §4) or the
contact changes, at which point "which address gets the alert" resurfaces.

**4. Security must land *before* real forwarders, not after — and the real boundary is RLS, not
the UI.**

**The potential breach.** This is a no-backend SPA: the browser calls Supabase **directly** with
the **public anon key**, so **Row-Level Security is the *only* server-side data boundary.**
Forwarders are **competitors**, and the catastrophic failure is **forwarder A reading (or
writing into) forwarder B's pricing.** It's not hypothetical hand-waving — any signed-in user
can open the dev console and run:

```js
await supabase.from('rates').select('*')      // what comes back is decided ENTIRELY by RLS
```

If a single policy is wrong, that query leaks a competitor's rates. The concrete ways it goes
wrong: (a) **RLS not enabled** on a table → it returns *everything* to *anyone* (incl. the anon
key); (b) a **too-broad `SELECT`** policy — remember Postgres policies are **OR'd** (permissive),
so one loose policy widens access for everyone; (c) a **missing `WITH CHECK`** on writes → a
forwarder inserts rows stamped with another `forwarder_id` (data poisoning); (d) `my_forwarder()`
/ `profiles` integrity breaking the `forwarder_id = my_forwarder()` predicate the whole isolation
rests on (`MEMORY.md` §3).

**Why the frontend items are NOT the breach (and what they actually are).** **Route guards**
(blocking a provider from `/requester/new`) and the **dev role toggle** are **UX, not security.**
A provider who types the URL or flips the toggle changes only the *client's* idea of their role —
it never changes `auth.uid()` or the JWT, and RLS keys on `profiles.role` via `auth.uid()`, not
on anything the browser claims. So RLS already backstops both. They still must be fixed
(env-gate the dev toggle **off** in prod; add route guards) — but as **hygiene/clarity in front
of competing companies**, not as the thing that stops a leak. The elegant reframing: **stop
thinking of the UI as a security layer; pour the effort into RLS.**

**The elegant, secure solution.**
1. **RLS is the boundary — make it minimal and explicit.** RLS **enabled on every table**
   (add a check that asserts it — a forgotten `enable row level security` is the worst leak);
   **no `USING (true)`**; every policy names its exact predicate; `SECURITY DEFINER` helpers pin
   `search_path = public` (already done). The anon role must get **zero** rows (it does: null
   `auth.uid()` → `my_forwarder()` null → no match).
2. **Prove isolation with a repeatable test, not a one-time glance.** Two forwarder accounts
   A + B: A submits a rate; as **B**, assert `select * from rates` returns **only B's** rows (zero
   of A's), **and** that B **cannot** insert a rate with A's `forwarder_id` (the `WITH CHECK`
   write-poison test). Re-run this **every time RLS changes** — it's the one promise, so automate
   its verification (pgTAP or a tiny two-session script) rather than trusting memory.
3. **Cheap defense-in-depth.** Never expose the **`service_role`** key to the browser (anon key
   only, `MEMORY.md` §8); keep `user_metadata.role` ↔ `profiles.role` in sync; the Cloudflare +
   magic-link gates keep *strangers* off the app but are **explicitly not** what isolates
   forwarders — don't let a CF identity substitute for a Supabase session, or `auth.uid()` is
   null and RLS stops protecting (`MOCKDEPLOY.md` §2 "two-gate" trap).

Net: ship **Phase E** before outsiders — env-gate the dev toggle, add route guards (hygiene),
and **re-verify the isolation test** against the company-keyed RLS. That test passing is the
green light to onboard competitors.

**5. Refresh-token fragility — an *availability* risk (and a credential to guard), not a leak.**

**The problem.** Phase-1 alert auth is a **delegated** refresh token (stored in
`graph_credentials`). Entra refresh tokens **rotate on each use** (we persist the new one) but
**die** on ~90-day inactivity, password change, MFA re-registration, a conditional-access change,
or an admin revoking sessions. When it dies, the refresh-grant returns `invalid_grant` and
**sends fail** — and on a serverless function with no human in the loop, that fails **silently**:
you hit *Send Rate Request* before a period, nothing goes out, forwarders never get the request,
and you may not notice. (Two upsides that soften it: sending every ~10-day period is *regular
use*, which keeps the token alive far from the 90-day cliff; and the token is **sensitive** but
already **locked** — `graph_credentials` is service-role-only, never anon/`VITE_`.)

**The elegant, secure solution.**
- **Phase 1 (delegated — make it loud, not silent).** Keep the locked storage + rotation-persist
  (`ALERTS.md` §6c). Critically, on `invalid_grant` the function must **fail loudly** — surface a
  clear UI error ("email auth expired — run `python graph.py seed`") **and** notify you, never a
  silent no-op. Add a **canary**: a tiny "test token" check (or a scheduled ping) that validates
  the token **before** a period blast, so you re-seed on your schedule, not mid-send. Re-seeding
  is a ~2-minute local `graph.py seed`.
- **Phase 2 (the durable fix — app-only removes the whole class).** Migrate to **app-only
  client-credentials** (`ALERTS.md` §6/§13): a confidential app with a secret/cert +
  admin-consented application `Mail.Send` + ApplicationAccessPolicy on the shared mailbox.
  App-only has **no refresh token and no user-session dependency** — nothing breaks on MFA / CA /
  password changes; the *only* upkeep is **rotating the client secret** before it expires (or use
  a long-lived certificate). The framing: delegated = "borrowing a human's session" (fragile);
  app-only = "the app has its own identity" (durable).

**Decision before real forwarders:** rehearse on delegated (you're watching it), but **migrate
to app-only before you *depend* on alerts** — silent non-delivery to real forwarders is the cost
of leaving it.

**6. No coverage masking yet — a *relevance* problem, explicitly NOT security.**

**The problem.** "Send to all" pushes **every** open lane to **every** forwarder — including
origins a forwarder never quotes (the Topocean/India case, `COVERAGE_MODEL.md`). Two harms, both
about noise not secrecy: (a) forwarders get irrelevant lanes, which erodes the "we get you" trust
that drives adoption; (b) those lanes sit **"outstanding" forever** (they'll never quote them),
which pollutes the reminder logic and the requester roster — you can't tell "ignored me" from
"doesn't cover this origin." Lanes are **shared, non-sensitive demand**, so a missed mask is
**annoyance, not a breach** (contrast #4) — which is exactly why the fix is a **query filter, not
RLS** (`COVERAGE_MODEL.md` §1).

**The elegant solution** (already designed in `COVERAGE_MODEL.md`).
- **Rules as data:** a `forwarder_coverage` table (`forwarder_id`, `mode` exclude/include,
  `dimension`, `match_value`). **Default = no rows = see everything** → safe rollout; you only
  add rows to carve out exceptions ("Topocean, exclude, origin_country, India" = one INSERT).
- **Apply as a query mask, not a policy:** a `lanes_to_fill` view/RPC (or a client-side filter)
  subtracts excluded origins. It **composes** straight into the outstanding-per-forwarder
  computation alerts already do (`ALERTS.md` §11) — one more predicate, no redesign.
- **Hard dependency — location normalization.** Matching "origin = India" needs a lane's
  **country**, but `pol` is free text today. Clean coverage is therefore **gated on canonical
  locations** (`pol_id → locations.country`); free-text `ILIKE '%India%'` is a fragile interim
  (misses "Nhava Sheva", false-matches "Indiana"). `COVERAGE_MODEL.md` §5/§7 sequences this.
- **You're not blocked meanwhile:** the **skip** action already lets a forwarder clear lanes they
  don't cover with reason **`no_coverage`** — coverage masking is just the *automation* of that
  manual skip.

**Decision before real forwarders (recommended path):** start by **accepting the noise + manual
`no_coverage` skips**; for a few **known** exclusions add interim **free-text rules** (you know
your data); build the clean `forwarder_coverage` + view **after** location normalization lands.

**7. Deliverability gotchas.** (a) Supabase's built-in auth email is rate-limited (~a few/hour)
— fine for 3 users, **add custom SMTP** before onboarding several. (b) First-time external
sends with an attachment can land in **junk** — warm up, watch spam folders during the
rehearsal, confirm primetimepackaging.com SPF/DKIM/DMARC are healthy (they are, since the CRM
sends). (c) Magic-link + CF both email the same person — make sure neither is filtered.

**8. Period / re-post mechanics interact with alerts.** Alerts key on `period`, but **re-post /
lane-extension** (period bump) and the **7-day auto-skip** rule are **not built** (`MEMORY.md`
§6). If you extend a lane mid-rehearsal, confirm period/outstanding/alerts behave; otherwise an
alert could re-include or drop lanes unexpectedly.

**9. Dashboards + roster are still mock.** Stat cards are hardcoded `—`, and there's no
requester **response roster** (who submitted / skipped / hasn't). The roster is what makes the
**reminder** UX legible (you pick non-responders) — worth building alongside Alerts, not after.

**10. Operational basics for a "real" deployment.** No error monitoring, no defined backup/PITR
posture (Supabase free tier is limited), no audit beyond the notifications log. Acceptable for a
rehearsal; note them before trusting the app with external parties' pricing.

## Open decisions (resolve as you hit them)
- Gate forwarders behind Cloudflare, or only the internal team? (#1 Option 2 — strong candidate).
- CF Access / Supabase session durations: set long to make the gates first-time-only (#1).
- Day-one forwarder return path: **app submit** vs **email/upload-back** (#1/#2).
- ~~Recipient address source~~ — **decided:** `profiles` email of the known rate-quoting
  contact; revisit only on multi-analyst forwarders (#3).
- Vercel raw-URL exposure: Pro deployment-protection vs Hobby login-only (`MOCKDEPLOY.md` §9).
- Coverage masking before real onboarding: build vs accept noise (#6).
- App-only Graph migration timing: rehearsal on delegated, switch before scale (#5).
Recommended next steps, in order
Prove the send today — graph.py seed once, then test-send to yourself. Zero dependencies, de-risks the whole transport before you build anything.
Build the Alerts slice — tables (notifications, notification_recipients, graph_credentials), template → Supabase Storage, the notify-forwarders Edge Function (port graph.py to Deno) + the 7-day cron + the two buttons/cooldown + inbound submit→team.
Build the provider .xlsx upload — close the return loop (same template, both directions).
Stage 4: deploy + gate — domain + Cloudflare ZT + magic link. Decide the gate option here.
Harden (Phase E) — route guards, env-gate the dev toggle, and run the isolation test with two forwarder accounts. ← this passing is your green light.
Onboard real forwarders (data-only flip).
Top things to keep honest about
The return path (#3) must exist before you lean on app submission — otherwise keep the email/upload-back fallback.
The isolation test is the gate, not a nicety — one wrong RLS policy leaks competitor pricing.
Fail loud on token death so a missed period blast never goes silent.