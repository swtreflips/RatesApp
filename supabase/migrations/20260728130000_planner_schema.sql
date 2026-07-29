-- Stuffer Planner backend — structure. See stufferPlanner/STUFFER.md.
--
-- Depends on 20260728120000_organizations_expand.sql: factories are organizations with
-- type='supplier'. There is no `suppliers` table and never will be.
--
-- Everything is prefixed `planner_`. In a database that already holds ocean rates, drayage
-- and sailing schedules, a bare `containers` or `master_items` is the same ambiguity the
-- ports -> world_ports rename removed.
--
-- SECURITY IS NOT HERE. This migration creates structure with RLS enabled and no policies,
-- which denies everyone. Policies land in the next migration, so there is never a window
-- where these tables are readable in a project holding partner accounts.

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_po_lines — one row per PO line.
--
-- KEY: (document_number, sku). Verified against the real 314-row export: that pair is unique
-- across all 314 rows, while Internal ID and Document Number each yield only 216 distinct
-- values — in that export they identify the PURCHASE ORDER, not the line.
--
-- internal_id is carried but deliberately NOT unique and NOT the key. Once NetSuite is wired
-- directly it is expected to become a real per-line identifier, at which point it can gain a
-- unique constraint — but the natural key stays (document_number, sku), because that is what
-- both the internal export and the supplier template can express today.
--
-- NB the two sample files come from different points in time and will not reconcile against
-- each other. That is expected; it says nothing about the key.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.planner_po_lines (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id),  -- WHOSE data this is

  document_number    text not null,
  sku                text not null,          -- "Item" in both files
  internal_id        text,                   -- NetSuite's PO id. NOT unique — see above

  -- internal-owned, from plannerInput.csv
  quantity           numeric,
  quantity_available numeric,
  due_date           date,
  origin             text,
  pol                text,
  destination        text,

  -- factory-owned. The supplier supplies ONE of the two CBM figures; see below.
  cargo_ready        date,
  cbm_per_case       numeric(12,6),
  cbm_total          numeric(12,3),

  -- resolved CBM. Same shape as drayage's fuel surcharge (DRAY.md 6d): each _eff column
  -- prefers its own direct input, then derives from the other, then 0.
  --
  -- GENERATED columns are writable by NOBODY, including service_role. That is deliberate:
  -- the derivation cannot be bypassed, so the column-write trigger and the history log only
  -- ever have to reason about the two input columns.
  cbm_per_case_eff numeric(12,6) generated always as (
    case
      when cbm_per_case is not null then cbm_per_case
      when cbm_total is not null and quantity > 0 then round(cbm_total / quantity, 6)
      else 0
    end
  ) stored,

  cbm_total_eff numeric(12,3) generated always as (
    coalesce(cbm_total, round(cbm_per_case * quantity, 3), 0)
  ) stored,

  -- stamped on FIRST set, never updated. Total slippage is then a subtraction, cheap enough
  -- to sort a grid by; the event log explains HOW it got there.
  original_cargo_ready date,

  committed_quantity numeric not null default 0,
  raw                jsonb,                  -- unmapped columns, so a CSV reshape loses nothing
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint planner_po_lines_key unique (document_number, sku),
  constraint planner_committed_le_quantity check (committed_quantity <= coalesce(quantity, 0))
);

create index if not exists planner_po_lines_org_idx    on public.planner_po_lines (organization_id);
create index if not exists planner_po_lines_sku_idx    on public.planner_po_lines (sku);
create index if not exists planner_po_lines_ready_idx  on public.planner_po_lines (cargo_ready);

-- ─────────────────────────────────────────────────────────────────────────────
-- planner_po_line_events — append-only history of supplier-supplied fields.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.planner_po_line_events (
  id              bigint generated always as identity primary key,
  po_line_id      uuid not null references public.planner_po_lines(id) on delete cascade,
  organization_id uuid not null,             -- denormalised so RLS needs no join
  field           text not null check (field in ('cargo_ready','cbm_per_case','cbm_total')),
  old_value       text,
  new_value       text,
  changed_by      uuid references public.profiles(id),   -- NULL for a service-role push
  source          text check (source in ('csv','grid','api')),
  created_at      timestamptz not null default now()
);

create index if not exists planner_events_line_idx  on public.planner_po_line_events (po_line_id, field, created_at desc);
create index if not exists planner_events_org_idx   on public.planner_po_line_events (organization_id);

-- Records only the INPUT columns. The _eff columns are generated and can never be updated,
-- so they can never generate an event — history records what a PERSON supplied, not what the
-- database computed. A per-case figure that shifts because internal re-pushed a quantity is
-- not a supplier changing their mind.
--
-- Living in a trigger rather than the app means a CSV upload and a single-cell grid edit
-- produce identical history, an update that changes nothing writes nothing, and no future
-- write path can bypass it.
create or replace function public.planner_log_po_line_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  src   text := coalesce(current_setting('planner.source', true), 'grid');
begin
  if new.cargo_ready is distinct from old.cargo_ready then
    insert into planner_po_line_events (po_line_id, organization_id, field, old_value, new_value, changed_by, source)
    values (new.id, new.organization_id, 'cargo_ready', old.cargo_ready::text, new.cargo_ready::text, actor, src);
  end if;

  if new.cbm_per_case is distinct from old.cbm_per_case then
    insert into planner_po_line_events (po_line_id, organization_id, field, old_value, new_value, changed_by, source)
    values (new.id, new.organization_id, 'cbm_per_case', old.cbm_per_case::text, new.cbm_per_case::text, actor, src);
  end if;

  if new.cbm_total is distinct from old.cbm_total then
    insert into planner_po_line_events (po_line_id, organization_id, field, old_value, new_value, changed_by, source)
    values (new.id, new.organization_id, 'cbm_total', old.cbm_total::text, new.cbm_total::text, actor, src);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_planner_log_po_line_changes on public.planner_po_lines;
create trigger trg_planner_log_po_line_changes
  after update on public.planner_po_lines
  for each row execute function public.planner_log_po_line_changes();

-- original_cargo_ready / updated_at, stamped BEFORE the row is written.
create or replace function public.planner_stamp_po_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cargo_ready is not null and new.original_cargo_ready is null then
    new.original_cargo_ready := new.cargo_ready;   -- first set only, never updated after
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_planner_stamp_po_line on public.planner_po_lines;
create trigger trg_planner_stamp_po_line
  before insert or update on public.planner_po_lines
  for each row execute function public.planner_stamp_po_line();

-- ─────────────────────────────────────────────────────────────────────────────
-- Containers
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.planner_containers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id),
  code             text not null unique,          -- <ORG><NNNN>, immutable after creation
  name             text,
  type             text check (type in ('20GP','40GP','40HC')),
  destination      text,
  capacity_cbm     numeric(12,3),
  display_order    integer not null default 0,
  status           text not null default 'draft' check (status in ('draft','committed')),

  ofq_reference    text,                           -- the forwarder's number. NOT RatesApp's OFQID
  committed_at     timestamptz,
  committed_by     uuid references public.profiles(id),

  logistics_status text check (logistics_status in ('committed','booked','scheduled','shipped')),
  booking          jsonb,
  schedule         jsonb,
  booked_at        timestamptz, booked_by    uuid references public.profiles(id),
  scheduled_at     timestamptz, scheduled_by uuid references public.profiles(id),
  shipped_at       timestamptz, shipped_by   uuid references public.profiles(id),

  -- Reserved for VARIATIONS.md draft views. NULL = the implicit baseline. Costs one nullable
  -- column now; adding it later means a structural migration on live containers.
  view_id          uuid,

  created_at       timestamptz not null default now()
);

create index if not exists planner_containers_org_idx on public.planner_containers (organization_id);

create table if not exists public.planner_allocations (
  id            uuid primary key default gen_random_uuid(),
  container_id  uuid not null references public.planner_containers(id) on delete cascade,
  po_line_id    uuid not null references public.planner_po_lines(id),
  quantity      numeric not null check (quantity > 0),
  display_order integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists planner_allocations_container_idx on public.planner_allocations (container_id);
create index if not exists planner_allocations_line_idx      on public.planner_allocations (po_line_id);

create table if not exists public.planner_sequences (
  org_code    text primary key references public.organizations(code),
  next_number integer not null default 1
);

create table if not exists public.planner_import_batches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id),
  pushed_at       timestamptz not null default now(),
  pushed_by       uuid references public.profiles(id),
  source          text,
  row_count       integer
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Views. A generated column cannot reference another row, so the CBM estimator has to be a
-- view — it aggregates across lines by (organization, sku).
-- ─────────────────────────────────────────────────────────────────────────────

-- Every CBM a supplier ever gave, with provenance and WHEN.
-- observed_at comes from the EVENT LOG, not planner_po_lines.updated_at: the row's timestamp
-- moves whenever any column changes, and internal re-pushes quantities weekly, so a
-- six-month-old measurement would look like it was taken yesterday.
create or replace view public.planner_cbm_observations as
select
  l.organization_id,
  l.sku,
  case when l.cbm_per_case is not null then 'per_case' else 'total' end as supplied_as,
  l.cbm_per_case_eff as cbm_per_case,
  l.cbm_total_eff    as cbm_total,
  l.quantity,
  l.document_number,
  e.created_at as observed_at,
  e.changed_by as observed_by,
  e.source     as observed_via
from public.planner_po_lines l
left join lateral (
  select created_at, changed_by, source
    from public.planner_po_line_events
   where po_line_id = l.id and field in ('cbm_per_case','cbm_total')
   order by created_at desc
   limit 1
) e on true
where l.cbm_per_case is not null or l.cbm_total is not null;

-- The estimator: what has this factory measured for this item before?
-- MEDIAN, not average — one mis-keyed decimal (0.42 for 0.042) drags an average by an order
-- of magnitude and poisons every estimate for that SKU. min/max keep a wide spread visible.
create or replace view public.planner_cbm_reference as
select
  organization_id,
  sku,
  count(*)                                                  as observations,
  count(*) filter (where supplied_as = 'per_case')          as measured_per_case,
  count(*) filter (where supplied_as = 'total')             as derived_from_total,
  percentile_cont(0.5) within group (order by cbm_per_case) as median_cbm_per_case,
  min(cbm_per_case)                                         as min_cbm_per_case,
  max(cbm_per_case)                                         as max_cbm_per_case,
  min(observed_at)                                          as first_observed_at,
  max(observed_at)                                          as last_observed_at
from public.planner_cbm_observations
group by organization_id, sku;

-- One row per genuine MOVE of a cargo ready date.
-- old_value is not null excludes the FIRST set: a supplier finally answering is not
-- slippage, and counting it overstates the problem.
create or replace view public.planner_crd_movements as
select
  e.po_line_id,
  l.organization_id,
  l.document_number,
  l.sku,
  e.old_value::date                     as moved_from,
  e.new_value::date                     as moved_to,
  e.new_value::date - e.old_value::date as days_moved,   -- negative = pulled EARLIER
  e.created_at                          as moved_at,
  e.changed_by,
  e.source
from public.planner_po_line_events e
join public.planner_po_lines l on l.id = e.po_line_id
where e.field = 'cargo_ready'
  and e.old_value is not null
  and e.new_value is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS on, no policies — denies everyone. Policies are the next migration.
-- service_role bypasses RLS, so the CSV import path keeps working throughout.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_po_lines       enable row level security;
alter table public.planner_po_line_events enable row level security;
alter table public.planner_containers     enable row level security;
alter table public.planner_allocations    enable row level security;
alter table public.planner_sequences      enable row level security;
alter table public.planner_import_batches enable row level security;

revoke all on public.planner_po_lines, public.planner_po_line_events,
              public.planner_containers, public.planner_allocations,
              public.planner_sequences, public.planner_import_batches
  from anon, authenticated;

revoke all on public.planner_cbm_observations, public.planner_cbm_reference,
              public.planner_crd_movements
  from anon, authenticated;

comment on table public.planner_po_lines is
  'PLANNER | OWNER: internal CSV push (later NetSuite) + factory edits | READ BY: Stuffer Planner | one row per PO line, keyed (document_number, sku)';
comment on table public.planner_po_line_events is
  'PLANNER | OWNER: trigger only | READ BY: Stuffer Planner, analytics | append-only history of supplier-supplied fields. Never written directly';
comment on table public.planner_containers is
  'PLANNER | OWNER: Stuffer Planner | READ BY: Stuffer Planner | draft and committed containers';
comment on table public.planner_allocations is
  'PLANNER | OWNER: Stuffer Planner | READ BY: Stuffer Planner | PO line quantities placed into a container';
comment on table public.planner_sequences is
  'PLANNER | OWNER: next_container_code() | READ BY: Stuffer Planner | per-organization container number counter';
comment on table public.planner_import_batches is
  'PLANNER | OWNER: internal CSV push | READ BY: ops | one row per import run';
comment on view public.planner_cbm_observations is
  'PLANNER | derived | every CBM a supplier supplied, with provenance and when';
comment on view public.planner_cbm_reference is
  'PLANNER | derived | median CBM per (organization, sku) — estimates cartons nobody measured';
comment on view public.planner_crd_movements is
  'PLANNER | derived | one row per cargo-ready date MOVE. Excludes the first set';
