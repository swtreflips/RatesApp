import React from 'react'

/**
 * The app's identity lockup — icon slot, name, descriptor.
 *
 * ONE STRUCTURE ACROSS THE ESTATE. Freight, Schedules and Planner each carry the same three
 * parts in the same proportions, and differ only in their own colour tokens. A module of the
 * system should be recognisable as one, and adding a fourth app should mean copying this file
 * rather than inventing a header.
 *
 * THE ICON SLOT IS RESERVED, NOT REMOVED. There is no icon yet, so the slot renders empty — but
 * it still occupies its full square, and the tile treatment (fill, radius, shadow) appears only
 * once something is passed in. An empty coloured tile would read as a broken image; empty space
 * reads as space. When the icon arrives, nothing around it moves.
 *
 * The name carries an accent full stop. It is the device Schedules already used, it gives each
 * app's accent colour somewhere to live while the icons are missing, and it is the cheapest
 * possible family signature.
 */

/** Single source of truth for what this app is called. */
export const APP_NAME = 'Freight'
export const APP_DESCRIPTOR = 'Rates & Bookings'

const SIZES = {
  // sidebar / top chrome
  sm: {
    slot: 'h-9 w-9 rounded-xl',
    gap: 'gap-2.5',
    name: 'text-base',
    descriptor: 'mt-0.5 text-[9px] tracking-[0.22em]',
  },
  // login and loading, where the lockup is the only thing on screen
  lg: {
    slot: 'h-12 w-12 rounded-2xl',
    gap: 'gap-3',
    name: 'text-3xl',
    descriptor: 'mt-1 text-[10px] tracking-[0.28em]',
  },
}

/**
 * @param {object}   props
 * @param {React.ReactNode} [props.icon]  goes in the reserved slot; omit until one exists
 * @param {'sm'|'lg'} [props.size]
 * @param {boolean}  [props.showText]     false collapses to the slot alone (collapsed sidebar)
 */
export function BrandMark({ icon = null, size = 'sm', showText = true, className = '' }) {
  const s = SIZES[size] ?? SIZES.sm

  return (
    <div className={`flex items-center ${s.gap} overflow-hidden ${className}`}>
      <span
        aria-hidden={icon ? undefined : 'true'}
        className={[
          'flex shrink-0 items-center justify-center',
          s.slot,
          // Tile treatment ONLY when filled — see the note above.
          icon ? 'bg-signal-500 text-harbor-950 shadow-signal' : '',
        ].join(' ')}
      >
        {icon}
      </span>

      {showText && (
        <span className="flex flex-col leading-none">
          {/*
            DM Sans at 600, tracked -0.02em — the same three values in all three apps, so the
            lockups are interchangeable. Deliberately NOT the skin's `tracking-tightest`: that
            varies from -0.01em to -0.04em across skins, and the one element meant to look
            identical everywhere should not move when a skin changes.

            Was `font-extrabold` (800), which DM Sans does not ship here — only 400-700 load, so
            the browser was synthesising it.
          */}
          <span className={`font-sans font-semibold tracking-[-0.02em] text-white ${s.name}`}>
            {APP_NAME}
            <span className="text-signal-400">.</span>
          </span>
          <span
            className={`font-mono uppercase text-harbor-300 ${s.descriptor}`}
          >
            {APP_DESCRIPTOR}
          </span>
        </span>
      )}
    </div>
  )
}
