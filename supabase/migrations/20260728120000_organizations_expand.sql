-- EXPAND: organizations, beside forwarders — HUB2.md "The organizations migration".
--
-- Additive and reversible. Nothing is dropped, nothing is remapped, and RatesApp does not
-- change a line: it keeps reading forwarder_id throughout. The contract phase (dropping
-- forwarder_id, forwarders, my_forwarder, profiles.role) is a separate migration, much later.
--
-- THE TRICK THAT MAKES THIS CHEAP: organizations rows carry the EXISTING forwarders.id values
-- unchanged. Every forwarder_id already stored in rates, drayage_rates and profiles is
-- therefore already a valid organization_id. A copy, not a remap — nothing to re-point, and
-- each step verifies with a query that must return zero.
--
-- type = 'internal' | 'forwarder' | 'supplier'
--   internal   PTP itself
--   forwarder  freight vendors        (RatesApp)
--   supplier   factories / goods vendors (Stuffer Planner)
--
-- NB 'supplier', not 'customer'. Both external types are parties PTP BUYS FROM; neither is a
-- customer, and the estate has none. HUB2 originally said 'customer'; corrected here and there.

create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  type       text not null check (type in ('internal', 'forwarder', 'supplier')),
  code       text unique check (code ~ '^[A-Z]{2}$'),  -- 2-letter, container numbering
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_services (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  service         text not null,
  active          boolean not null default true,
  primary key (organization_id, service)
);

-- ── carry the forwarders across, IDs intact ──────────────────────────────────
insert into public.organizations (id, name, type, active, created_at)
select f.id, f.name, 'forwarder', f.active, f.created_at
from public.forwarders f
on conflict (id) do nothing;

-- PTP itself. Internal users get a real organization_id, so the "null means internal"
-- special case disappears once contract lands.
--
-- The id is DETERMINISTIC on purpose. A gen_random_uuid() here would differ between every
-- environment, so seed.sql could not reference it and local fixtures could not point their
-- internal profiles anywhere. One fixed id means production and every rebuild agree.
insert into public.organizations (id, name, type, code)
values ('00000000-0000-0000-0000-000000000001', 'Prime Time Packaging', 'internal', 'PT')
on conflict (id) do nothing;

-- ── profiles gains organization_id, backfilled ───────────────────────────────
alter table public.profiles
  add column if not exists organization_id uuid references public.organizations(id);

update public.profiles p
   set organization_id = p.forwarder_id
 where p.forwarder_id is not null
   and p.organization_id is distinct from p.forwarder_id;

update public.profiles p
   set organization_id = (select id from public.organizations where type = 'internal' limit 1)
 where p.role = 'internal'
   and p.organization_id is null;

-- ── the facade now reads organization_id ─────────────────────────────────────
-- ONLY the bodies change. Every policy in RatesApp, Schedules and the planner keeps working,
-- untouched. This is the entire payoff of having written them against these names.
create or replace function public.my_org()
returns uuid language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid();
$$;

create or replace function public.my_org_type()
returns text language sql stable security definer set search_path = public as $$
  select o.type from profiles p join organizations o on o.id = p.organization_id
   where p.id = auth.uid();
$$;

-- ── security ─────────────────────────────────────────────────────────────────
alter table public.organizations         enable row level security;
alter table public.organization_services enable row level security;

revoke all on public.organizations         from anon;
revoke all on public.organization_services from anon;
grant select on public.organizations         to authenticated;
grant select on public.organization_services to authenticated;

-- Everyone signed in may read the directory: policies elsewhere join to it, and a name is
-- not sensitive. Writes are onboarding only — no policy, so only service_role can write.
create policy organizations_read on public.organizations
  for select to authenticated using (true);

create policy organization_services_read on public.organization_services
  for select to authenticated using (true);

comment on table public.organizations is
  'SHARED IDENTITY | OWNER: onboarding | READ BY: EVERY APP + all RLS via my_org()/my_org_type() | one row per party. type: internal=PTP, forwarder=freight vendor, supplier=factory';
comment on table public.organization_services is
  'SHARED IDENTITY | OWNER: onboarding | READ BY: RatesApp | which services an organization provides';

-- ── VERIFY — every one of these must return zero rows ────────────────────────
-- Run them after applying. A non-empty result means the backfill is wrong; stop and fix
-- before anything is built on top.
--
--   -- every forwarder has a matching organization with the SAME id
--   select f.id, f.name from forwarders f
--     left join organizations o on o.id = f.id where o.id is null;
--
--   -- every profile with a forwarder_id has the identical organization_id
--   select id, forwarder_id, organization_id from profiles
--    where forwarder_id is not null and organization_id is distinct from forwarder_id;
--
--   -- no internal profile left without an organization
--   select id, role from profiles where role = 'internal' and organization_id is null;
