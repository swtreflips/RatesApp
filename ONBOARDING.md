# Onboarding — Users & Forwarders

**How to add a person (internal teammate or forwarder analyst) and a new forwarder company.**
Onboarding is **data-only**: you create rows. You never touch RLS policies or code.
Created June 21, 2026. Relates to `MEMORY.md` §2–§3 (schema + RLS), `ALERTS.md` §0.5 (recipients).

---

## The model — two places, both required

A working user needs **both**, and they must agree:

| # | Where | What | Read by |
|---|-------|------|---------|
| 1 | **Authentication** (dashboard menu) | the login: `auth.users` row + `user_metadata.role` | the **frontend** (routing) |
| 2 | **SQL / Table editor** | a matching `profiles` row (same role, `forwarder_id` for forwarders) | **RLS** (`current_role_is`, `my_forwarder`) |

> Keep `user_metadata.role` (place 1) **↔** `profiles.role` (place 2) in sync. Two stores, must match.
> The SQL editor runs as service-role (bypasses RLS), which is why there are no insert policies on
> `profiles` / `forwarders` — you onboard here, not through the app.

Roles: **`internal`** (your team) · **`forwarder`** (freight forwarder analyst).

---

## A. Add an INTERNAL teammate

1. **Authentication → Users → Add User** → email + password.
2. Click the user → edit **Raw user metadata**:
   ```json
   { "role": "internal", "full_name": "Their Name" }
   ```
3. **SQL editor** — add the profile (paste the user's UUID from the Users list):
   ```sql
   insert into profiles (id, role) values ('<auth-uid>', 'internal');
   ```
   (No `forwarder_id` — internal users don't belong to a forwarder.)

---

## B. Add a FORWARDER analyst

1. **Authentication → Users → Add User** → email + password. *(This email is what receives
   rate-request notifications — `auth.users.email`.)*
2. Edit **Raw user metadata**:
   ```json
   { "role": "forwarder", "full_name": "Their Name" }
   ```
3. **SQL editor** — create the **company first** (only if it's new), then the profile:
   ```sql
   -- once per company (skip if it already exists; grab its id from `select id, name from forwarders`)
   insert into forwarders (name) values ('Tanera Transport') returning id;

   -- the analyst → links them to that company
   insert into profiles (id, role, forwarder_id)
   values ('<auth-uid>', 'forwarder', '<forwarder-id>');
   ```

**Multiple analysts at one forwarder:** run step B once per person, all with the **same
`<forwarder-id>`**. Create the company (step 3 first statement) **only once**.

Placeholders: `<auth-uid>` = from Authentication → Users · `<forwarder-id>` = the company row's id.

4. **Set the analyst's service tags** (see §C below). New analysts default to both flags `true`
   (= `ALL`); if they only handle one service, set the other flag `false` in the same sitting:
   ```sql
   update profiles set full_name = 'Their Name',
                       receives_rate_requests   = true,    -- handles ocean
                       receives_drayage_requests = false   -- does NOT handle drayage
   where id = '<auth-uid>';
   ```

---

## C. Service capability & analyst tags (ocean · drayage · both)

Two independent dials, both data-only (DRAY.md §2a/§7a):

| Dial | Where | Controls |
|---|---|---|
| **Company capability** | `forwarder_services` rows | which service **panels** the company's analysts see, and which directories the company appears in |
| **Analyst tags** | `profiles.receives_rate_requests` (ocean) + `profiles.receives_drayage_requests` (drayage) | the `OCEAN` / `DRAYAGE` / `ALL` **chip** next to the analyst in the Send modal — guidance for the sender |

### C1. Onboard a company into a service (or remove one)
```sql
-- company starts offering drayage (panel + directory appear on their next load)
insert into forwarder_services (forwarder_id, service)
values ('<forwarder-id>', 'drayage')
on conflict do nothing;

-- pause soliciting a service without losing the row
update forwarder_services set active = false
where forwarder_id = '<forwarder-id>' and service = 'drayage';

-- remove it entirely
delete from forwarder_services
where forwarder_id = '<forwarder-id>' and service = 'drayage';
```
**When adding a company's first drayage row, set its analysts' drayage flags in the same script**
(otherwise everyone defaults to `true` → every chip reads `ALL`):
```sql
-- C and D handle drayage; A and B don't
update profiles set receives_drayage_requests = (id in ('<C-uid>','<D-uid>'))
where forwarder_id = '<forwarder-id>';
```

### C2. Change an analyst's coverage (ocean ⇄ drayage ⇄ both)
```sql
-- make an analyst drayage-only
update profiles set receives_rate_requests = false, receives_drayage_requests = true
where id = '<auth-uid>';
-- make an analyst handle both  → chip shows ALL
update profiles set receives_rate_requests = true, receives_drayage_requests = true
where id = '<auth-uid>';
```
Flag combos → chip: ocean only → `OCEAN` · drayage only → `DRAYAGE` · both → `ALL` · neither →
untagged (listed in the modal, never suggested). The chip is always **capped by company capability**
— an ocean-only company's analysts show at most `OCEAN` regardless of flags.

### C3. What the flags actually DO (read this)
- **Today (notify v1, ocean):** `receives_rate_requests` is still a hard **filter** — opted-out
  analysts are not emailed (see the Notifications section below).
- **After notify v2 (DRAY.md §9b step 3):** both flags become **display-only tags**. They never
  pre-select or filter recipients; the Send modal pre-checks the *last set actually emailed* for
  that service (memory), and a first-ever send starts blank for a manual pick. Update the flags on
  analyst on/offboarding anyway — stale chips mislead exactly when the sender relies on them.

### C4. Verify
```sql
select f.name company, coalesce(p.full_name, split_part(u.email,'@',1)) analyst,
       p.receives_rate_requests tag_ocean, p.receives_drayage_requests tag_drayage,
       array_agg(fs.service) filter (where fs.active) services
from forwarders f
join profiles p on p.forwarder_id = f.id
join auth.users u on u.id = p.id
left join forwarder_services fs on fs.forwarder_id = f.id
group by 1,2,3,4;
```
Expect: `services` lists exactly what the company offers; tags match who handles what.

---

## Why you NEVER re-run RLS as you onboard

The isolation policies are defined **once on the tables** and evaluate **dynamically per request** —
new people and companies are covered automatically the moment their rows exist.

```sql
-- a forwarder sees/manages only their own COMPANY's rates
create policy "forwarder rates" on rates
  for all using (forwarder_id = my_forwarder());

-- my_forwarder() resolves the logged-in user's company live, every query:
--   select forwarder_id from profiles where id = auth.uid();
```

Consequences:
- **Company-level isolation.** Two analysts at the same forwarder **share** their company's Active
  Rates (teammates, by design). Different forwarders **cannot** see each other's rates.
- **Internal users** see **all** rates (lane-linked *and* independent) via the `requester reads
  rates` policy (`current_role_is('internal')`).
- **Fails closed.** Forget the `profiles` row (or `forwarder_id` is null) → `my_forwarder()` is null →
  user sees **nothing**, never someone else's data. The only way to leak across companies is putting
  the **wrong** `forwarder_id` on step B.3 → **double-check the company UUID.**

So: **policies = structural, set once. Onboarding = data only (`profiles.forwarder_id`).**

---

## Notifications — who receives rate-request emails

A forwarder analyst is emailed when **all** are true (checked by `get_forwarder_recipients()`):
- their `profiles.forwarder_id` is set (step B.3), and
- `profiles.receives_rate_requests = true` (default), and
- `forwarders.active = true` (default), and
- their `auth.users` email exists.

Controls (SQL editor, no UI yet):
```sql
-- opt one analyst out of emails
update profiles p set receives_rate_requests = false
from auth.users u where u.id = p.id and u.email = 'analyst@company.com';

-- turn a whole company off
update forwarders set active = false where name = 'Tanera Transport';
```
If a forwarder shows **"no active recipients"** in the Send modal → no analyst `profiles` row is
linked to that `forwarder_id` yet (step B.3 not done), or they've been opted out / deactivated.

---

## Verify after onboarding

```sql
-- see a company's analysts + their email + opt-in flag
select p.id, u.email, p.role, p.receives_rate_requests, f.name as forwarder
from profiles p
join auth.users u on u.id = p.id
left join forwarders f on f.id = p.forwarder_id
where f.name = 'Tanera Transport';
```
- Log in as the new forwarder → **Active Rates** shows only their company's rows (isolation check).
- Open the Send modal (as internal) → the forwarder now lists their analyst email(s).

---

## Quick troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Logs in but app looks wrong / blank role | `user_metadata.role` missing or ≠ `profiles.role` | sync the two (steps 2 + 3) |
| Forwarder sees no rates | no `profiles` row, or `forwarder_id` null | add the `profiles` row with the right `forwarder_id` |
| Forwarder sees the **wrong** company's rates | wrong `forwarder_id` on the profile | correct it (the only real isolation risk) |
| "no active recipients" in Send modal | no analyst linked / opted out / company inactive | step B.3, or flip `receives_rate_requests` / `active` |
