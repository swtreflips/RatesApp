-- Bookings — which sailing was chosen for an ocean rate. SAILINGS.md §4b.
--
-- Bookings answers what a move costs and says nothing about when the box arrives. The schedules
-- warehouse already holds the other half and is keyed on (carrier_code, port_of_loading, last_cy)
-- — precisely the three facts an ocean rate carries — so the panel can offer the real sailings
-- that could carry a booking. This table records which one someone picked.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A COPY OF THE SAILING AND NOT A FOREIGN KEY
--
-- The obvious design is a reference to schedules_latest. It does not survive contact with how
-- that object works: the MV is rebuilt from scratch on every ingest, and it only considers
-- scrapes from the last 5 days. The exact row picked today is likely to be gone next week — not
-- changed, GONE — and a foreign key would give a decision that quietly evaporates.
--
-- A copy is also what "we chose this sailing" actually means. The decision is a fact about what
-- was known and agreed at the time; it should not be able to change underneath the person who
-- made it, and it must stay legible after the feed has moved on. schedule_hash is kept as a
-- breadcrumb back to the source row for anyone reconciling later, deliberately NOT as an FK.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY KEYED ON (ofq_id, ofr_id) AND NOT ON A SNAPSHOT
--
-- A pick belongs to the OCEAN RATE, not to the quote and not to the uploaded sheet.
--
-- Two rates on one OFQ can be genuinely different products: Nhava Sheva → Los Angeles where the
-- box rails on to Salt Lake City is not interchangeable with Nhava Sheva → Los Angeles where the
-- box stays at the port. Same POD, different move. So each rate carries its own sailing.
--
-- Tying the row to booking_snapshots.id instead would erase every decision the next time someone
-- uploaded a fresher seed, which is exactly backwards: re-uploading the sheet is routine, and
-- decisions made against it are the thing worth keeping. ofq_id and ofr_id are stable business
-- identifiers that outlive any one snapshot.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.booking_schedule_picks (
  id                uuid primary key default gen_random_uuid(),

  -- The ocean rate this sailing was chosen for. Business identifiers from the OFR seed, not
  -- FKs — the snapshot they arrived in is replaceable, the decision is not.
  ofq_id            text not null,
  ofr_id            text not null,

  -- The sailing itself, copied. schedule_hash identifies the source row at the time of picking.
  schedule_hash     text,
  carrier_code      text,
  port_of_loading   text,
  last_cy           text,
  port_of_discharge text,
  etd               date,
  pod_eta           date,
  eta               date,
  transit_time_days integer,
  transport_type    text,        -- 'Direct' | '1 TS' | '2 TS' | '3 TS' | '4 TS' — free text on
                                 -- purpose; the feed has already outgrown its own declared union
  mother_vessel     text,

  picked_by         uuid references public.profiles(id),
  picked_at         timestamptz not null default now(),

  -- One sailing per ocean rate. Also the upsert target: re-picking replaces, never duplicates.
  constraint booking_schedule_picks_key unique (ofq_id, ofr_id)
);

-- The page loads every pick for the OFQs on screen in one read.
create index if not exists booking_schedule_picks_ofq_idx
  on public.booking_schedule_picks (ofq_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- NO EXPIRY COLUMN, DELIBERATELY
--
-- A pick stops counting once its ETD has passed, but that is DERIVED on read (`etd < today`),
-- never stored and never written back. Storing it would need something to run — a job, a trigger,
-- a nightly sweep — to keep a column true that a date comparison already answers for free, and
-- it would go wrong silently the first time that job did not run.
--
-- This mirrors how expired ocean rates work on the same screen (bookings/rateValidity.js): the
-- stored data stays complete and the question is asked fresh against today, every render. The
-- row is KEPT when it lapses — what was chosen, and by whom, stays legible.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — internal only, and MUTABLE (unlike booking_snapshots)
--
-- booking_snapshots deliberately has no UPDATE policy: a snapshot is a photograph and you do not
-- retouch a photograph. A pick is the opposite kind of object. It is a decision, changing your
-- mind is the normal case, and the sailing you wanted may sail without you. So this table gets
-- update and delete.
--
-- Forwarders get no policy at all. This sits beside booking_snapshots, which names every
-- forwarder's rate on every lane — the read pattern here would leak which carrier and sailing we
-- are planning around, and that is nobody's business but ours.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.booking_schedule_picks enable row level security;

revoke all on public.booking_schedule_picks from anon, authenticated;
grant select, insert, update, delete on public.booking_schedule_picks to authenticated;

create policy booking_schedule_picks_read on public.booking_schedule_picks
  for select to authenticated
  using (my_org_type() = 'internal');

-- picked_by = auth.uid() so the audit trail cannot be forged, matching booking_snapshots_insert.
create policy booking_schedule_picks_insert on public.booking_schedule_picks
  for insert to authenticated
  with check (my_org_type() = 'internal' and picked_by = auth.uid());

-- Any internal user may re-pick, not only the original picker. This is a shared operating
-- picture: whoever is looking at the booking now is the person who needs to change it, and
-- routing that through the colleague who happened to click first would just stall the decision.
create policy booking_schedule_picks_update on public.booking_schedule_picks
  for update to authenticated
  using (my_org_type() = 'internal')
  with check (my_org_type() = 'internal' and picked_by = auth.uid());

create policy booking_schedule_picks_delete on public.booking_schedule_picks
  for delete to authenticated
  using (my_org_type() = 'internal');

comment on table public.booking_schedule_picks is
  'BOOKINGS | OWNER: internal, from the Bookings itinerary panel | READ BY: Bookings | the sailing chosen for one ocean rate, COPIED from schedules_latest_secure rather than referenced — the MV is rebuilt every ingest on a 5-day window, so a reference would evaporate. Expiry is derived from etd on read, never stored';
comment on column public.booking_schedule_picks.schedule_hash is
  'The source row in schedules_latest at the time of picking. A breadcrumb for reconciliation, deliberately not a foreign key';
