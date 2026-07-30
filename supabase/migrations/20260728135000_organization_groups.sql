-- Sibling companies — one team, several factories.
--
-- THE PROBLEM
--   Ditar S.A (Colombia) is the relationship. The same people also run Packaging Manufacture
--   of America, S.A. in Guatemala, and can move production between them. Junsun Packaging
--   (Thailand) and Qingdao Junsun Packaging (China) are the same again — in that case even
--   the same legal entity, but the reason is operational either way.
--
--   Those factories must stay SEPARATE organizations: different countries, different POs,
--   different containers, and "which factory is making this" must never become unanswerable.
--   What is shared is the PEOPLE. One team should handle both, with a toggle.
--
-- THE RULE THAT KEEPS THIS SAFE
--   A group widens ACCESS. It never merges OWNERSHIP.
--   Every PO line, container and allocation keeps its own organization_id. Container codes
--   stay per-organization (DT0001, PM0001). Grouping only changes who may LOOK.
--
-- SYMMETRY IS DELIBERATE
--   Everyone in a group sees every organization in it. A group means "the same people run
--   these" — that is the only reason to create one. The case where a sibling is run by a
--   DIFFERENT team is already handled by not grouping them at all, which is exactly how the
--   owner described wanting to handle it. No parent/child asymmetry is built, because nothing
--   asked for it.

create table if not exists public.organization_groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,     -- "Ditar", "Junsun" — the relationship, not a legal entity
  notes      text,
  created_at timestamptz not null default now()
);

alter table public.organizations
  add column if not exists group_id uuid references public.organization_groups(id),
  -- which member is the relationship we actually talk to. Display and reporting only; it
  -- confers no extra access, because access is symmetric within a group.
  add column if not exists is_group_primary boolean not null default false;

create index if not exists organizations_group_idx on public.organizations (group_id);

-- At most one primary per group. Without this, "who do we actually talk to" quietly becomes
-- ambiguous the first time someone ticks a second box.
create unique index if not exists organizations_one_primary_per_group
  on public.organizations (group_id) where is_group_primary;

-- ─────────────────────────────────────────────────────────────────────────────
-- my_orgs() — every organization the caller may act for.
--
-- Ungrouped (the normal case, and every forwarder) returns exactly one row, so this is a
-- strict superset of my_org() and behaves identically where no group exists.
--
-- Policies should use `organization_id in (select my_orgs())`. my_org() is kept for the
-- single-organization answer the UI needs — "which one am I, primarily" — and for the
-- existing policies written against it.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.my_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.id
    from profiles p
    join organizations me on me.id = p.organization_id
    join organizations o
      on o.id = me.id                                        -- always yourself
      or (me.group_id is not null and o.group_id = me.group_id)  -- plus siblings
   where p.id = auth.uid()
     and o.active;
$$;

comment on function public.my_orgs() is
  'Every organization the caller may act for: their own, plus any sibling sharing a group. Returns exactly one row when ungrouped. Use `organization_id in (select my_orgs())` in policies.';

alter table public.organization_groups enable row level security;
revoke all on public.organization_groups from anon;
grant select on public.organization_groups to authenticated;

-- Readable by anyone signed in: policies join to it and a group name is not sensitive.
-- Writes are onboarding only — no policy, so service_role alone.
create policy organization_groups_read on public.organization_groups
  for select to authenticated using (true);

comment on table public.organization_groups is
  'SHARED IDENTITY | OWNER: onboarding | READ BY: EVERY APP via my_orgs() | sibling companies run by the same team. Widens access, never merges ownership';
