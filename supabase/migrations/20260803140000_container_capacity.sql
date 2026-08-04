-- Container CBM capacity becomes editable data instead of a constant in the bundle.
--
-- src/data/containerCapacity.ts held these as a hard-coded record, so learning that a 40HC
-- actually takes 68 m³ rather than 65 meant a code change, a build and a deploy. These are not
-- engineering constants — they are what the loading team can actually achieve with THIS product
-- in boxes, and that number is discovered by doing it, repeatedly, over months.
--
-- TWO NUMBERS PER TYPE, and they mean different things:
--
--   max_cbm                  the STRUCTURAL ceiling. Allocation is refused past it. This is the
--                            box itself — roughly fixed, and lowering it can put already-loaded
--                            containers over capacity.
--   default_operational_cbm  the realistic packing cap STAMPED ONTO A NEW CONTAINER at creation.
--                            Lower than the ceiling because boxes do not tessellate perfectly.
--                            This is the number that moves as the team gets better or the
--                            product mix changes.
--
-- CHANGES ARE NOT RETROACTIVE. planner_containers.capacity_cbm is stamped at creation and stays
-- put, so raising the default from 65 to 68 affects containers made from now on and leaves every
-- existing plan exactly as its planner left it. The per-container cap is still editable on the
-- card for the one-off case. Nothing here reaches back into work already arranged.

create table if not exists public.planner_container_capacity (
  container_type text primary key
    check (container_type in ('20GP','40GP','40HC')),

  max_cbm                 numeric(10,3) not null check (max_cbm > 0),
  default_operational_cbm numeric(10,3) not null check (default_operational_cbm > 0),

  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id),

  -- The operational cap is a target inside the ceiling; above it the pair is nonsense and the
  -- allocation guard would refuse what the creation default just handed out.
  constraint planner_capacity_operational_le_max
    check (default_operational_cbm <= max_cbm)
);

-- The values that were in the bundle, so nothing changes on the day this ships.
insert into public.planner_container_capacity (container_type, max_cbm, default_operational_cbm)
values ('20GP', 33, 29),
       ('40GP', 67, 57),
       ('40HC', 76, 65)
on conflict (container_type) do nothing;

create or replace function public.planner_stamp_capacity()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();     -- read here, never accepted from the client
  return new;
end;
$$;

drop trigger if exists trg_planner_stamp_capacity on public.planner_container_capacity;
create trigger trg_planner_stamp_capacity
  before insert or update on public.planner_container_capacity
  for each row execute function public.planner_stamp_capacity();

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_container_fill — how full each container actually is
--
-- Exists so the settings panel can answer "would lowering this ceiling strand anything?" before
-- the save rather than after. Lowering max_cbm is the dangerous direction: it cannot break the
-- database, but it can leave a loaded container reading as over capacity, and the person typing
-- the new number is the one who should find that out.
--
-- security_invoker so RLS on planner_containers applies — a factory sees only its own.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.planner_container_fill
with (security_invoker = true) as
select
  c.id,
  c.code,
  c.type,
  c.status,
  c.capacity_cbm,
  coalesce(sum(a.quantity * l.cbm_per_case_eff), 0)::numeric(12,3) as total_cbm
from public.planner_containers c
left join public.planner_allocations a on a.container_id = c.id
left join public.planner_po_lines   l on l.id = a.po_line_id
group by c.id, c.code, c.type, c.status, c.capacity_cbm;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — EVERYONE READS, internal writes
--
-- Read is deliberately not internal-only. Factories create draft containers and see the fill
-- bars on them, so the client needs these numbers for every signed-in planner user. Restricting
-- reads to internal would leave a supplier with no ceiling guard and no fill bar — the allocation
-- dialog would silently stop bounding cases, which is a worse failure than showing them three
-- rows of volume limits that are not secret in the first place.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_container_capacity enable row level security;

revoke all on public.planner_container_capacity from anon, authenticated;
grant select on public.planner_container_capacity to authenticated;
grant update on public.planner_container_capacity to authenticated;

create policy planner_capacity_read on public.planner_container_capacity
  for select to authenticated
  using (true);

-- Any internal user may adjust the limits; a factory may not. No INSERT and no DELETE policy —
-- the three types are the three types, and a capacity row appearing or vanishing at runtime
-- would leave containers of that type with no ceiling at all.
create policy planner_capacity_update on public.planner_container_capacity
  for update to authenticated
  using      (my_org_type() = 'internal')
  with check (my_org_type() = 'internal');

grant select on public.planner_container_fill to authenticated;

comment on table public.planner_container_capacity is
  'PLANNER | OWNER: internal, via Settings | READ BY: every planner user | per-type CBM limits. max_cbm is the structural ceiling allocation is refused past; default_operational_cbm is stamped onto NEW containers only — changes are never retroactive';
comment on view public.planner_container_fill is
  'PLANNER | derived | current CBM loaded into each container, for the capacity panel''s impact check';
