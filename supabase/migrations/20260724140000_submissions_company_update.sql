-- Same bug as 20260724130000, on the two submission (acknowledgement) tables.
--
-- CAUSE: `for all ... with check (forwarder_id = my_forwarder() and provider_id = auth.uid())`.
-- WITH CHECK validates the RESULTING row on UPDATE, so an analyst can only ever update an ack
-- they personally created. Real failure paths:
--   * drayage_submissions — skipDrayageLane flips a teammate's submitted ack to skipped (or
--     re-skips an already-skipped lane).
--   * rate_submissions   — submitRates flips a prior `skipped` ack to `submitted`. If analyst A
--     skipped the lane and B later submits, B is rejected.
-- Acks are a COMPANY position on a lane, not a personal one — one ack row per (lane, forwarder).
--
-- FIX: same split as drayage_rates. INSERT keeps `provider_id = auth.uid()` (you must stamp
-- yourself as the author); UPDATE/DELETE/SELECT are company-level. provider_id stays as the
-- attribution of whoever first took the position.

do $$
declare pol record;
begin
  for pol in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('drayage_submissions', 'rate_submissions')
      and cmd = 'ALL'
      and coalesce(with_check, '') like '%provider_id%'
  loop
    execute format('drop policy %I on %I', pol.policyname, pol.tablename);
  end loop;
end $$;

-- ── drayage_submissions ───────────────────────────────────────────────────────
create policy "forwarder reads drayage submissions" on drayage_submissions
  for select using (forwarder_id = my_forwarder());

create policy "forwarder inserts drayage submissions" on drayage_submissions
  for insert with check (forwarder_id = my_forwarder() and provider_id = auth.uid());

create policy "forwarder updates drayage submissions" on drayage_submissions
  for update using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder());

create policy "forwarder deletes drayage submissions" on drayage_submissions
  for delete using (forwarder_id = my_forwarder());

-- ── rate_submissions (ocean) ──────────────────────────────────────────────────
create policy "forwarder reads submissions" on rate_submissions
  for select using (forwarder_id = my_forwarder());

create policy "forwarder inserts submissions" on rate_submissions
  for insert with check (forwarder_id = my_forwarder() and provider_id = auth.uid());

create policy "forwarder updates submissions" on rate_submissions
  for update using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder());

create policy "forwarder deletes submissions" on rate_submissions
  for delete using (forwarder_id = my_forwarder());
