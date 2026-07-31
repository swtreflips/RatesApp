-- Let people resolve each other's names — narrowly.
--
-- `profiles` had exactly one policy: `own profile` (id = auth.uid()). Correct for RatesApp,
-- which never displays another user, but the planner does:
--
--   "Jordan is editing this row"            presence / row locks
--   "Booked 12 Aug · Maria"                 container lifecycle stamps
--
-- With own-profile-only those render as blanks, and a lock held by someone you cannot name
-- is indistinguishable from a bug.
--
-- WHO MAY SEE WHOM
--   internal  → everyone. They coordinate across all suppliers.
--   supplier  → their own colleagues (including sibling plants), PLUS internal staff.
--
-- Internal has to be visible to suppliers because only internal commits, books and ships —
-- every lifecycle stamp on a supplier's own container names an internal user. Their names
-- are not a secret to a factory you already do business with.
--
-- A supplier still cannot see a COMPETITOR's staff. That is the same boundary as the rest of
-- the planner: rival factories learn nothing about each other, including who works there.
--
-- NO RECURSION: my_org_type() and my_orgs() are SECURITY DEFINER, so they read profiles with
-- RLS bypassed. A policy on profiles calling them does not re-enter this policy. Writing the
-- same condition inline with a sub-select on profiles WOULD recurse.

create policy profiles_directory_read on public.profiles
  for select to authenticated
  using (
    id = auth.uid()                                    -- always yourself
    or my_org_type() = 'internal'                      -- internal sees everyone
    or organization_id in (select my_orgs())           -- your own org, and siblings
    or exists (                                        -- internal staff, visible to all
      select 1 from public.organizations o
       where o.id = profiles.organization_id
         and o.type = 'internal'
    )
  );

comment on policy profiles_directory_read on public.profiles is
  'Name resolution for presence and lifecycle stamps. Internal sees all; a supplier sees its own organizations (incl. siblings) plus internal staff, never a competitor''s people.';
