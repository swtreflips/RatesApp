-- Partner accounts are created with a temporary password that someone reads out or emails.
-- Without a marker, that temporary password quietly becomes the permanent one — nobody
-- remembers which accounts were handed over months ago and never changed.
--
-- WHAT THIS FLAG IS: a NUDGE. It drives a banner asking the user to set their own password.
--
-- WHAT IT IS NOT: a security control. Anyone who can call `mark_password_changed()` can clear
-- their own banner without changing anything, and that is accepted — the only person harmed is
-- the one hiding their own reminder. Making it enforceable would mean detecting a real password
-- change, which lives in `auth.users.encrypted_password`; a trigger there would couple this
-- schema to Supabase's internal auth tables and break on an upgrade at the worst possible time.
--
-- The account-creation runbook is the real control: set this true when you issue the temporary
-- password, and the person sees the banner until they act on it.

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

comment on column public.profiles.must_change_password is
  'The user is still on a temporary password issued during onboarding. Drives a banner only — see 20260803160000. Cleared by mark_password_changed(), never by the client directly';

/*
  Clearing the flag is an RPC because it HAS to be.

  `profiles` carries exactly one policy — `profiles_directory_read`, a SELECT — and no UPDATE
  policy at all. That is deliberate and load-bearing: it is what stops a signed-in user rewriting
  their own `role` from the browser console, which RatesApp's AuthProvider calls out by name.

  So the choice was never "RPC or a writable column". Adding an UPDATE policy to let someone
  clear a banner would open the row that identity is read from, to buy a nag flag. This function
  is SECURITY DEFINER and touches exactly one boolean on exactly the caller's row.
*/
create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  update public.profiles
     set must_change_password = false
   where id = auth.uid();
end;
$$;

revoke all on function public.mark_password_changed() from anon;
grant execute on function public.mark_password_changed() to authenticated;

comment on function public.mark_password_changed() is
  'Clears the caller''s own temporary-password banner. Called by the client after auth.updateUser succeeds. A nudge, not an enforcement point';
