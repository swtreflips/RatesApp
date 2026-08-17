import React from 'react'
import { Link } from 'react-router-dom'

/**
 * The app's identity lockup — icon slot and wordmark.
 *
 * ONE STRUCTURE ACROSS THE ESTATE. Freight, Schedules and Planner carry the same two parts in the
 * same proportions and differ only in their own accent. Adding a fourth app should mean copying
 * this file, not designing a header.
 *
 * ── Why the wordmark is set in Fraunces and the interface is not ──────────────────────────────
 * A logotype wants a face the interface does not use — Adobe Clean, Google Sans and Atlassian's
 * Charlie all exist for this reason. Set in the UI face at UI weight, a name reads as a label; the
 * mark here did, which is why it looked raw. Fraunces is a soft serif with real SOFT and WONK
 * axes, built to feel hand-cut, and it holds that warmth down to 16px.
 *
 * It is loaded through `--font-logo`, NOT the skin's `--font-display`, because the skins redefine
 * display as four different faces. The one element meant to look identical everywhere must not
 * move when a skin changes.
 *
 * OPTICAL SIZING IS THE BROWSER'S JOB. The font is requested with `opsz` as a range, so it stays
 * variable and `font-optical-sizing: auto` — the default — picks the right optical size for 16px
 * and for 30px on its own. Setting `font-variation-settings` here would silently switch that off.
 * Weight and SOFT are pinned in the request instead.
 *
 * ── The slot ─────────────────────────────────────────────────────────────────────────────────
 * A soft wash of the app's own accent, no shadow, generous radius. It used to be a solid fill with
 * a drop shadow, which is the iOS app-chip convention and would fight a painted illustration.
 * A wash reads as ground rather than as a container.
 *
 * The wash is heavier here than in the other two apps: this lockup sits on a dark rail, and an 8%
 * tint that reads clearly on white disappears on #112424.
 *
 * ── The monogram ─────────────────────────────────────────────────────────────────────────────
 * Until real icons exist the slot shows the app's initial, in the logotype face. It stops the
 * reserved space from reading as a gap, gives the collapsed rail something to be, and lets the
 * three apps look like a family before any art is drawn. Pass `icon` and it disappears — that is
 * the whole of its lifecycle, and deleting it later is one conditional.
 */

/** Single source of truth for what this app is called. */
export const APP_NAME = 'Freight'
/** Not rendered in the lockup any more; still the module's description, used for titles. */
export const APP_DESCRIPTOR = 'Rates & Bookings'

const SIZES = {
  // sidebar / top chrome
  sm: {
    slot: 'h-9 w-9 rounded-2xl',
    gap: 'gap-2.5',
    name: 'text-base tracking-[-0.005em]',
    monogram: 'text-[15px]',
  },
  // login and loading, where the lockup is the only thing on screen
  lg: {
    slot: 'h-12 w-12 rounded-[1.15rem]',
    gap: 'gap-3',
    name: 'text-3xl tracking-[-0.02em]',
    monogram: 'text-xl',
  },
}

/**
 * @param {object} props
 * @param {React.ReactNode} [props.icon]  fills the slot and replaces the monogram
 * @param {'sm'|'lg'} [props.size]
 * @param {boolean} [props.showText]      false collapses to the slot alone (collapsed rail)
 * @param {string}  [props.to]            when set, the lockup links home
 */
export function BrandMark({ icon = null, size = 'sm', showText = true, to, className = '' }) {
  const s = SIZES[size] ?? SIZES.sm

  const inner = (
    <>
      <span
        className={[
          'flex shrink-0 items-center justify-center overflow-hidden',
          s.slot,
          // Accent wash — no shadow, no solid fill. Doubled against the dark rail.
          'bg-signal-400/[0.16]',
        ].join(' ')}
      >
        {icon ?? (
          <span
            aria-hidden="true"
            className={`font-logo font-medium leading-none text-signal-300 ${s.monogram}`}
          >
            {APP_NAME.charAt(0)}
          </span>
        )}
      </span>

      {showText && (
        <span className={`font-logo font-medium leading-none text-white ${s.name}`}>
          {APP_NAME}
          <span className="text-signal-400">.</span>
        </span>
      )}
    </>
  )

  const shell = `flex items-center ${s.gap} overflow-hidden ${className}`

  // A brand that goes home is the convention; without `to` it stays inert rather than
  // pretending to be clickable.
  if (!to) return <div className={shell}>{inner}</div>

  return (
    <Link to={to} aria-label={`${APP_NAME} — home`} className={`${shell} group`}>
      {inner}
    </Link>
  )
}
