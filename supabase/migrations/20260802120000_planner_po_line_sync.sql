-- Weekly ERP snapshot sync — structure.
--
-- planner_po_lines held 315 rows loaded by hand from plannerInput.csv, and planner_import_batches
-- had 0 rows to show for it. Every Monday a fresh NetSuite export has to bring the table back in
-- line: new lines appear, quantities move as cases ship, and lines disappear once fulfilled,
-- cancelled, or deleted upstream because they were entered wrong.
--
-- The file is a COMPLETE SNAPSHOT of what is open, so it is treated as one. Three sets fall out
-- and no diff has to be computed by the client:
--
--     in file, not in table  ->  insert
--     in file and in table   ->  update the internal-owned columns
--     in table, not in file  ->  CLOSE.  never delete.
--
-- WHY CLOSE AND NOT DELETE. Not a preference — this schema already decided it:
--
--   * planner_allocations.po_line_id is NO ACTION, so a line sitting in anyone's container
--     cannot be deleted at all. The delete raises and takes the whole batch with it.
--   * planner_po_line_events CASCADEs, so deleting a line destroys its cargo-ready history AND
--     its CBM observations. planner_cbm_reference is built on those and only gets better with
--     age; deleting fulfilled lines quietly erodes the estimator every week.
--   * There is no DELETE policy on planner_po_lines, so nothing can delete today anyway.
--   * A line can come back. A reopened PO — or a row dropped by an export filter glitch — would
--     lose every bit of supplier enrichment on the way out.
--
-- Closing keeps all of it, and makes reopening free.
--
-- Functions live in the next migration. This one is structure only.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Lifecycle columns
--
-- status stays BINARY on purpose. Whether a line is on the board and why it is not are separate
-- axes; folding the reason into the status couples them and makes every later filter awkward.
--
-- The default is what makes the existing 315 rows the baseline with no backfill — next Monday's
-- upload is already a diff.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_po_lines
  add column if not exists status text not null default 'open'
    check (status in ('open','closed')),
  add column if not exists closed_at timestamptz,

  -- Mondays this line was present in. The whole basis of the 'withdrawn' inference below, which
  -- is why the sync increments it for every line in the file rather than only changed ones.
  add column if not exists snapshots_seen integer not null default 1,
  add column if not exists reopen_count   integer not null default 0,

  add column if not exists last_seen_at timestamptz,
  add column if not exists last_seen_batch_id uuid references public.planner_import_batches(id),

  -- THE GUESS.
  add column if not exists closed_reason_inferred text
    check (closed_reason_inferred in ('fulfilled','cancelled','withdrawn','unknown')),

  -- THE TRUTH, and the only field that is one.
  add column if not exists closed_reason_confirmed text
    check (closed_reason_confirmed in ('fulfilled','cancelled','withdrawn','other')),
  add column if not exists closed_note text,
  add column if not exists closed_confirmed_by uuid references public.profiles(id),
  add column if not exists closed_confirmed_at timestamptz;

create index if not exists planner_po_lines_status_idx
  on public.planner_po_lines (status)
  where status = 'open';

/*
  THE BASELINE DID NOT ARRIVE THROUGH A SYNC, so its counter would be a lie.

  The 315 rows already in this table were loaded by hand. `default 1` would claim each was seen
  in exactly one snapshot, which is the fingerprint of a line entered and withdrawn — so the
  first of them to close having never shipped would be inferred 'withdrawn' when in truth it has
  been open for months and nobody knows why it left.

  Setting them to 2 says the honest thing: seen more than once, arrival not observed. The
  withdrawn rule then declines to fire on them and they infer 'unknown', which is correct — the
  evidence for 'withdrawn' genuinely does not exist for a row that predates the sync.

  No-op on a fresh `supabase db reset`, where there are no rows yet to misdescribe.
*/
update public.planner_po_lines
   set snapshots_seen = 2
 where snapshots_seen = 1
   and created_at < now();

/*
  WHY THE REASON IS THREE COLUMNS AND NOT ONE.

  The feed never says why a row left. A line entered in error and deleted upstream looks
  IDENTICAL to a genuine cancellation — both simply vanish with quantity still available. A
  single closed_reason column would have to guess between them, and would then be read as fact
  by everyone downstream forever.

  So the three things are kept apart:

      observed   the frozen row + snapshots_seen + reopen_count     sync writes, certain
      inferred   closed_reason_inferred                             sync writes, a labelled guess
      confirmed  closed_reason_confirmed, closed_note               a HUMAN writes, never the sync

  Nothing extra is needed to observe: a closed row stops being updated, so quantity,
  quantity_available and cargo_ready are already a snapshot of the last time the ERP mentioned it.

  The inference rules, in order:

      quantity_available = 0                        -> fulfilled
      quantity > quantity_available (shipped some)  -> cancelled
      snapshots_seen = 1 and nothing ever shipped   -> withdrawn    <- the data-entry case
      otherwise                                      -> unknown

  snapshots_seen = 1 is what makes 'withdrawn' separable at all. A line that appeared in one
  export and was gone by the next, having never moved a case, is far more likely a correction
  than a real cancellation. One integer, and it is the only signal available.

  'unknown' is a real outcome and is shown as such rather than rounded to the nearest guess.

  Confirming NEVER overwrites the inference — once merged into one column you can no longer tell
  which you are looking at.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. planner_po_line_status_events — the arc
--
-- A line can close, reopen and close again. The columns above hold only the latest state, so
-- the history needs an append-only log.
--
-- DELIBERATELY NOT planner_po_line_events. That table is constrained to
-- field in ('cargo_ready','cbm_per_case','cbm_total') because its purpose is WHAT A PERSON
-- SUPPLIED, and planner_cbm_observations reads it to date CBM measurements. Widening the check
-- to carry status changes would put machine events into a table the estimator treats as human
-- input, and every observation date would start lying.
--
-- Same split the schema already makes for original_cargo_ready: a column for what a grid sorts
-- by, a log for how it got there.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.planner_po_line_status_events (
  id              bigint generated always as identity primary key,
  po_line_id      uuid not null references public.planner_po_lines(id) on delete cascade,
  organization_id uuid not null,          -- denormalised so RLS needs no join, as with the sibling log
  from_status     text,
  to_status       text not null check (to_status in ('open','closed')),
  inferred_reason text,
  batch_id        uuid references public.planner_import_batches(id),
  created_at      timestamptz not null default now()
);

create index if not exists planner_status_events_line_idx
  on public.planner_po_line_status_events (po_line_id, created_at desc);
create index if not exists planner_status_events_org_idx
  on public.planner_po_line_status_events (organization_id);
create index if not exists planner_status_events_batch_idx
  on public.planner_po_line_status_events (batch_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The check constraint that breaks the weekly sync
--
--     check (committed_quantity <= coalesce(quantity, 0))
--
-- The invariant is right. It is enforced in the wrong place. When the ERP drops a quantity below
-- what is already committed into containers — the ordinary case where a supplier ships part of a
-- PO and the remainder is corrected down — this UPDATE raises and THE ENTIRE BATCH ABORTS. One
-- line the warehouse already worked through stops Monday for all eighteen suppliers.
--
-- The rule belongs to the ALLOCATION path, not the sync path. The source of truth must be free
-- to tell the truth; an over-committed line is then a visible conflict rather than a failure.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_po_lines
  drop constraint if exists planner_committed_le_quantity;

create or replace function public.planner_stamp_po_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cargo_ready is not null and new.original_cargo_ready is null then
    new.original_cargo_ready := new.cargo_ready;   -- first set only, never updated after
  end if;

  -- Refuse a COMMIT that exceeds the open quantity; allow the QUANTITY to fall beneath one that
  -- already happened. The direction of travel is the whole distinction: committing 500 against
  -- 300 available is a mistake being made now, whereas 500 committed against a quantity the ERP
  -- has since revised to 300 is a fact that needs reporting, not rejecting.
  if tg_op = 'INSERT' then
    if new.committed_quantity > coalesce(new.quantity, 0) then
      raise exception 'cannot commit % against an open quantity of %',
        new.committed_quantity, coalesce(new.quantity, 0);
    end if;
  elsif new.committed_quantity > coalesce(old.committed_quantity, 0)
    and new.committed_quantity > coalesce(new.quantity, 0) then
    raise exception 'cannot commit % against an open quantity of %',
      new.committed_quantity, coalesce(new.quantity, 0);
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The column guard learns the new columns
--
-- Without this a supplier could resurrect a cancelled PO onto the board, or rewrite the record
-- of why their own line closed. RLS grants access to ROWS, not columns — this trigger is the
-- only thing standing between a factory and every internal-owned field on a line it owns.
--
-- Confirming a reason needs no new policy: planner_po_lines_update already admits internal, and
-- this guard keeps factories out.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.planner_guard_po_line_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role and internal are unrestricted. auth.uid() is null for service_role.
  if auth.uid() is null or my_org_type() = 'internal' then
    return new;
  end if;

  if new.document_number    is distinct from old.document_number
  or new.sku                is distinct from old.sku
  or new.internal_id        is distinct from old.internal_id
  or new.organization_id    is distinct from old.organization_id
  or new.quantity           is distinct from old.quantity
  or new.quantity_available is distinct from old.quantity_available
  or new.due_date           is distinct from old.due_date
  or new.origin             is distinct from old.origin
  or new.pol                is distinct from old.pol
  or new.destination        is distinct from old.destination
  or new.committed_quantity is distinct from old.committed_quantity
  or new.raw                is distinct from old.raw
  -- everything the weekly sync owns
  or new.status                  is distinct from old.status
  or new.closed_at               is distinct from old.closed_at
  or new.snapshots_seen          is distinct from old.snapshots_seen
  or new.reopen_count            is distinct from old.reopen_count
  or new.last_seen_at            is distinct from old.last_seen_at
  or new.last_seen_batch_id      is distinct from old.last_seen_batch_id
  or new.closed_reason_inferred  is distinct from old.closed_reason_inferred
  or new.closed_reason_confirmed is distinct from old.closed_reason_confirmed
  or new.closed_note             is distinct from old.closed_note
  or new.closed_confirmed_by     is distinct from old.closed_confirmed_by
  or new.closed_confirmed_at     is distinct from old.closed_confirmed_at
  then
    raise exception
      'a supplier may only change cargo_ready, cbm_per_case and cbm_total on a PO line';
  end if;

  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Batch counts
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_import_batches
  add column if not exists inserted_count  integer not null default 0,
  add column if not exists updated_count   integer not null default 0,
  add column if not exists closed_count    integer not null default 0,
  add column if not exists reopened_count  integer not null default 0,
  add column if not exists unchanged_count integer not null default 0,
  add column if not exists conflicts jsonb not null default '[]'::jsonb;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. planner_po_line_closures — the awareness view
--
-- The point of keeping closed lines is being able to answer "what happened to this PO", so the
-- question gets a view rather than a query somebody rewrites from memory each time.
--
-- security_invoker: the Settings page reads this as an ordinary authenticated internal user, so
-- RLS on planner_po_lines has to apply. Without it the view would run as owner and hand a
-- factory every other factory's closures.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.planner_po_line_closures
with (security_invoker = true) as
select
  l.id,
  l.organization_id,
  o.name as supplier,
  l.document_number,
  l.sku,
  l.closed_at,
  (l.closed_at::date - l.created_at::date) as days_open,
  l.snapshots_seen,
  l.reopen_count,
  -- frozen at the last sync that saw the line; a closed row stops being updated
  l.quantity,
  l.quantity_available,
  l.committed_quantity,
  l.cargo_ready,
  exists (select 1 from public.planner_allocations a where a.po_line_id = l.id) as was_allocated,
  coalesce(l.closed_reason_confirmed, l.closed_reason_inferred) as reason,
  -- travels WITH reason so no consumer can mistake a guess for a fact
  (l.closed_reason_confirmed is not null) as reason_is_confirmed,
  l.closed_reason_inferred,
  l.closed_note,
  l.closed_confirmed_at
from public.planner_po_lines l
join public.organizations o on o.id = l.organization_id
where l.status = 'closed';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.planner_po_line_status_events enable row level security;

revoke all on public.planner_po_line_status_events from anon, authenticated;
grant select on public.planner_po_line_status_events to authenticated;

-- Read-only to everyone. Rows are written by the sync function alone, which runs as definer.
create policy planner_status_events_read on public.planner_po_line_status_events
  for select to authenticated
  using (my_org_type() = 'internal' or organization_id in (select my_orgs()));

grant select on public.planner_po_line_closures to authenticated;

comment on table public.planner_po_line_status_events is
  'PLANNER | OWNER: sync_po_lines() only | READ BY: Stuffer Planner settings | append-only open/closed arc per PO line. Never written directly';
comment on view public.planner_po_line_closures is
  'PLANNER | derived | one row per closed PO line: when, how long it lived, whether it was allocated, and the reason — with reason_is_confirmed saying whether that reason is a fact or the sync''s guess';
comment on column public.planner_po_lines.snapshots_seen is
  'Weekly snapshots this line appeared in. Basis of the withdrawn inference: seen once and never shipped is a data-entry correction, not a cancellation';
comment on column public.planner_po_lines.closed_reason_inferred is
  'The sync''s GUESS at why the line left the feed. Never authoritative — see closed_reason_confirmed';
comment on column public.planner_po_lines.closed_reason_confirmed is
  'What a person established actually happened. Written only by a human, never by the sync';
