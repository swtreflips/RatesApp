import React from 'react'
import { NavLink } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

/**
 * Shared presentational primitives for role dashboards.
 * Pure styling — no business logic — so requester and provider
 * surfaces stay visually consistent (see CLAUDE.md shared-component philosophy).
 */

/* Accent token maps — keeps the maritime palette centralised */
const ACCENT = {
  harbor: {
    chip: 'bg-harbor-50 text-harbor-600 ring-harbor-100',
    bar:  'bg-harbor-400',
  },
  signal: {
    chip: 'bg-signal-50 text-signal-700 ring-signal-100',
    bar:  'bg-signal-500',
  },
  sea: {
    chip: 'bg-sea-50 text-sea-700 ring-sea-100',
    bar:  'bg-sea-500',
  },
}

/* ─── Page header ─────────────────────────────────────────────────────── */

export function PageHeader({ kicker, title, subtitle, actions }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {kicker && (
          <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-fog-400">
            {kicker}
          </p>
        )}
        <h1 className="text-2xl font-extrabold text-harbor-950">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fog-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/* ─── Stat card ───────────────────────────────────────────────────────── */

export function StatCard({ label, value, icon: Icon, accent = 'harbor', index = 0, hint }) {
  const a = ACCENT[accent] ?? ACCENT.harbor
  return (
    <div
      className="group relative overflow-hidden rounded-2xl border border-fog-200 bg-white p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* Top accent bar */}
      <span className={`absolute inset-x-0 top-0 h-0.5 ${a.bar} opacity-70`} />

      <div className="flex items-start justify-between">
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${a.chip}`}>
          <Icon size={19} strokeWidth={1.9} />
        </span>
      </div>

      <p className="mt-4 font-mono text-3xl font-semibold leading-none text-harbor-900 nums">
        {value}
      </p>
      <p className="mt-2 text-xs font-medium uppercase tracking-wide text-fog-400">
        {label}
      </p>
      {hint && (
        <p className="mt-1.5 text-xs text-fog-500">{hint}</p>
      )}
    </div>
  )
}

/* ─── Section card ────────────────────────────────────────────────────── */

export function SectionCard({ title, action, children }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
      {title && (
        <div className="flex items-center justify-between border-b border-fog-100 px-6 py-3.5">
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-fog-500">
            {title}
          </h2>
          {action}
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  )
}

/* ─── Scroll table ────────────────────────────────────────────────────── */

/**
 * Bounded-height card for a data table whose header stays pinned while the body scrolls.
 * `<main>` is the app's scroll container (TopNav sits above it), so making this card its own
 * scroll context lets the sticky header anchor to the card top. Pass the usual `<thead>/<tbody>`
 * as children.
 * @param {{ minWidth?: string|number, maxHeight?: string|number, children: React.ReactNode }} props
 */
export function ScrollTable({ minWidth, maxHeight = '70vh', children }) {
  return (
    <div
      className="overflow-auto rounded-2xl border border-fog-200 bg-white shadow-card"
      style={{ maxHeight }}
    >
      <table
        className="w-full text-left text-sm [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-fog-50"
        style={minWidth ? { minWidth } : undefined}
      >
        {children}
      </table>
    </div>
  )
}

/* ─── Quick actions ───────────────────────────────────────────────────── */

/**
 * Compact list of shortcut links for a dashboard side column.
 * @param {{ items: { label: string, to: string, icon: React.ComponentType }[] }} props
 */
export function QuickActions({ items }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-fog-200 bg-white shadow-card">
      <div className="border-b border-fog-100 px-6 py-3.5">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-fog-500">
          Quick Actions
        </h2>
      </div>
      <div className="p-2">
        {items.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className="group flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium text-harbor-700 transition-colors hover:bg-fog-50 hover:text-harbor-900"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-fog-100 text-fog-500 ring-1 ring-inset ring-fog-200 transition-colors group-hover:bg-signal-50 group-hover:text-signal-700 group-hover:ring-signal-100">
              <Icon size={16} strokeWidth={1.9} />
            </span>
            <span className="flex-1 truncate">{label}</span>
            <ChevronRight size={15} className="text-fog-300 transition-transform group-hover:translate-x-0.5 group-hover:text-fog-400" />
          </NavLink>
        ))}
      </div>
    </div>
  )
}
