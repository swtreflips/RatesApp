import React, { useState } from 'react'
import { Check, Eye, EyeOff, KeyRound } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../app/providers/AuthProvider'

/*
  Set your own password.

  Forwarder accounts are created by internal staff with a temporary password that gets read out
  or emailed. This is where that becomes something only the person holding it knows. Internal
  users get the same panel — everyone has a password, and there is no reason the people who
  issue them should be the only ones unable to change their own.

  THE CURRENT PASSWORD IS VERIFIED, and Supabase does not require it.
  `auth.updateUser({ password })` succeeds on any live session, and this project has
  `security_update_password_require_reauthentication` off — so without this check, reaching an
  unattended logged-in browser is enough to lock the real user out of their own account with no
  credential at all.

  Re-authenticating with `signInWithPassword` as the SAME user swaps one valid session for an
  equivalent one, which is harmless. A failed attempt leaves the existing session untouched, so a
  wrong guess costs a message and nothing else.

  Deliberately a twin of stufferPlanner's PasswordPanel, in harbor/fog rather than navy. One
  login spans every Prime Time tool, so the place you change it should not feel like a different
  product depending on which app you happened to be in — see logistics-os/OS/DESIGN.md.
*/

/** Project setting, `password_min_length`. Stated up front rather than discovered by rejection. */
const MIN_LENGTH = 10

export default function PasswordPanel() {
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const tooShort = next.length > 0 && next.length < MIN_LENGTH
  const mismatch = confirm.length > 0 && next !== confirm
  const sameAsOld = next.length > 0 && next === current
  const canSubmit =
    !busy && current.length > 0 && next.length >= MIN_LENGTH && next === confirm && !sameAsOld

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      // 1. Prove they know the current one.
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: current,
      })
      if (authError) {
        setError('That current password is not right.')
        return
      }

      // 2. Set the new one.
      const { error: updateError } = await supabase.auth.updateUser({ password: next })
      if (updateError) {
        setError(updateError.message)
        return
      }

      // 3. Clear the onboarding banner. Its failure is swallowed on purpose: the password IS
      //    changed by this point, and reporting an error over a nag flag would tell the user
      //    their password did not change when it did. Worst case the banner shows once more.
      await supabase.rpc('mark_password_changed')

      setCurrent('')
      setNext('')
      setConfirm('')
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="p-5">
        <p className="inline-flex items-center gap-2 text-sm font-semibold text-sea-700">
          <Check size={16} />
          Password updated.
        </p>
        <p className="mt-1 text-xs text-fog-500">
          Use it next time you sign in — here and in any other Prime Time tool you have access to.
        </p>
        <button
          type="button"
          onClick={() => setDone(false)}
          className="mt-3 rounded-lg px-3 py-1.5 text-xs font-semibold text-fog-600 transition-colors hover:bg-fog-100 hover:text-harbor-800"
        >
          Change it again
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="max-w-md space-y-3 p-5">
      <p className="text-xs text-fog-500">
        Signed in as <span className="font-mono text-harbor-800">{user?.email}</span>. This is the
        same login for every Prime Time tool, so changing it here changes it everywhere.
      </p>

      <Field label="Current password">
        <input
          type={reveal ? 'text' : 'password'}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          className={INPUT}
        />
      </Field>

      <Field label={`New password — at least ${MIN_LENGTH} characters`}>
        <div className="relative">
          <input
            type={reveal ? 'text' : 'password'}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className={`${INPUT} pr-9`}
          />
          {/* A reveal toggle, not a strength meter. Typing a long password blind is the actual
              reason people pick short ones. */}
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? 'Hide passwords' : 'Show passwords'}
            className="absolute inset-y-0 right-2 flex items-center text-fog-400 transition-colors hover:text-harbor-700"
          >
            {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </Field>

      <Field label="Confirm new password">
        <input
          type={reveal ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className={INPUT}
        />
      </Field>

      {tooShort && <Note>{MIN_LENGTH - next.length} more characters needed.</Note>}
      {mismatch && <Note>The two new passwords do not match.</Note>}
      {sameAsOld && <Note>That is the password you already have.</Note>}
      {error && <Note>{error}</Note>}

      <button
        type="submit"
        disabled={!canSubmit}
        className="inline-flex items-center gap-1.5 rounded-lg bg-harbor-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-harbor-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <KeyRound size={16} />
        {busy ? 'Updating…' : 'Update password'}
      </button>
    </form>
  )
}

const INPUT =
  'w-full rounded-lg border border-fog-200 bg-fog-50 px-3 py-2 text-sm text-harbor-900 outline-none transition-colors focus:border-signal-400'

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-fog-400">
        {label}
      </span>
      {children}
    </label>
  )
}

function Note({ children }) {
  return <p className="text-xs text-red-600">{children}</p>
}
