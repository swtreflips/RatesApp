-- rates (ocean): company-level truth, matching drayage_rates and both submissions tables.
--
-- NO BEHAVIOR CHANGE TODAY. `rates` is insert + select only in app code (recordRatesService,
-- submissionService, rateRequestService, applyRatesService) — nothing updates or deletes a rate
-- row, so the old policy's WITH CHECK never fired. This is applied now so all four rate/submission
-- tables state the same rule, before ocean supersession / bid-acceptance (BIDDING.md) adds the
-- write path that would otherwise reproduce the drayage Confirm bug.
--
-- THE RULE: the COMPANY decides who may touch a row. auth.uid() appears only on INSERT, where it
-- stamps authorship — it stops you writing a row under a teammate's name, it does not reserve that
-- row for them. Any analyst at a forwarder may amend any of that forwarder's rows.
--
-- CONSEQUENCE: provider_id now means "who first created this row", not "who owns it". It goes
-- stale once a teammate amends the row. If who-last-touched-it ever matters (most likely for a
-- confirm-style attestation), record it explicitly — RLS is not an audit trail.

do $$
declare pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'rates'
      and cmd = 'ALL'
      and coalesce(with_check, '') like '%provider_id%'
  loop
    execute format('drop policy %I on rates', pol.policyname);
  end loop;
end $$;

create policy "forwarder reads rates" on rates
  for select using (forwarder_id = my_forwarder());

create policy "forwarder inserts rates" on rates
  for insert with check (forwarder_id = my_forwarder() and provider_id = auth.uid());

create policy "forwarder updates rates" on rates
  for update using (forwarder_id = my_forwarder())
  with check (forwarder_id = my_forwarder());

create policy "forwarder deletes rates" on rates
  for delete using (forwarder_id = my_forwarder());
