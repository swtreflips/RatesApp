-- Bookings — the OFR seed becomes a shared snapshot instead of browser state.
--
-- BOOKINGS.md §242 said "No persistence", and that was right for v1: selecting a combo is pure
-- exploration and nothing about a SELECTION deserves saving. It is still right. What was wrong
-- was that the FILE lived in browser state too, so a reload emptied the page and the sheet one
-- person had was invisible to everyone else. Two different things had been folded into one
-- decision.
--
-- So this stores the sheet and nothing else:
--
--   stored      the OFQ universe and the ocean rates applied to them, exactly as parsed
--   NOT stored  which drayage option someone clicked, which OFQ was expanded, any total
--
-- Drayage keeps coming live from drayage_rates on every page load. Freezing it into the
-- snapshot would mean a two-week-old sheet quoting two-week-old trucking, and drayage moves on
-- its own schedule — the whole point of that table is that it is current.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A JSONB DOCUMENT AND NOT NORMALISED TABLES
--
-- The planner's PO lines are normalised because they are a LIVING dataset: suppliers edit cargo
-- ready dates on them, allocations point at them by id, and a weekly sync reconciles them row by
-- row. None of that is true here.
--
-- A booking snapshot is a PHOTOGRAPH OF A FILE at a moment. Nothing edits a row inside it, and
-- nothing should be able to — the value of "this is what the sheet said on Monday" survives only
-- as long as the answer cannot be quietly amended afterwards. Normalising would create rows that
-- look editable and invite exactly that.
--
-- It also means the page renders from ONE read with no joins, and the payload is already in the
-- shape the component consumes.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.booking_snapshots (
  id          uuid primary key default gen_random_uuid(),
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references public.profiles(id),

  file_name   text,

  -- Denormalised counts, so the history list and the staleness banner never have to open a
  -- payload to say "47 OFQs · 112 rates". Written by the client from the same parse that built
  -- the payload; a check keeps them from being negative but they are descriptive, not load-bearing.
  ofq_count   integer not null default 0 check (ofq_count >= 0),
  ofr_count   integer not null default 0 check (ofr_count >= 0),

  -- The parsed universe: Ofq[] with their oceanOptions, exactly as groupByOfqWithOptions returns.
  payload     jsonb   not null,

  constraint booking_snapshots_payload_is_array check (jsonb_typeof(payload) = 'array')
);

-- The page's only hot query is "the latest one", and history is the same order.
create index if not exists booking_snapshots_recent_idx
  on public.booking_snapshots (uploaded_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — internal only, and IMMUTABLE
--
-- There is deliberately NO UPDATE POLICY. A snapshot is a photograph; you do not retouch a
-- photograph, you take a new one. Correcting a bad upload means uploading the right file, which
-- becomes the latest — and the wrong one stays in history where it can be seen for what it was.
--
-- Forwarders have no policy here at all, so they read nothing. This is internal planning data:
-- it names every forwarder's rate on every lane side by side, which is precisely the thing no
-- forwarder may see.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.booking_snapshots enable row level security;

revoke all on public.booking_snapshots from anon, authenticated;
grant select, insert on public.booking_snapshots to authenticated;
grant delete on public.booking_snapshots to authenticated;

create policy booking_snapshots_read on public.booking_snapshots
  for select to authenticated
  using (my_org_type() = 'internal');

-- Any internal user may post a fresher sheet. Whoever has the newer export should not have to
-- find an admin; uploaded_by records who did it, and a wrong file is fixed by a right one.
create policy booking_snapshots_insert on public.booking_snapshots
  for insert to authenticated
  with check (my_org_type() = 'internal' and uploaded_by = auth.uid());

-- Deleting is housekeeping, not correction, so it is narrower than inserting.
create policy booking_snapshots_delete on public.booking_snapshots
  for delete to authenticated
  using (my_org_type() = 'internal' and my_org_role() = 'admin');

comment on table public.booking_snapshots is
  'BOOKINGS | OWNER: internal upload | READ BY: Bookings page | immutable photograph of an OFR seed export — the OFQ universe and the ocean rates applied to it. Drayage is NOT in here; it is read live from drayage_rates';
comment on column public.booking_snapshots.payload is
  'Ofq[] as groupByOfqWithOptions returns it. Never edited in place — a correction is a new snapshot';
