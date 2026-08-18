import React from 'react'
import { NavLink } from 'react-router-dom'
import { BrandMark } from './BrandMark'
import {
  LayoutDashboard,
  FilePlus,
  ClipboardList,
  LineChart,
  ChevronLeft,
  ChevronRight,
  FileText,
  Upload,
  Route,
  Container,
  TrendingUp,
} from 'lucide-react'
import { useAuth } from '../../app/providers/AuthProvider'
import { ROLES, ROLE_LABELS } from '../../lib/roles'
import { serviceConfig } from '../../features/rates/serviceConfig'

/* ─── Nav definitions ─────────────────────────────────────────────────────
   Stacked per-service groups (DRAY.md §3a): Dashboard sits OUTSIDE the groups;
   each service the user can access renders as a labeled section. Groups come
   from AuthProvider `services`, so a forwarder company with one capability
   sees exactly one panel and internal always sees every shipped service. */

const internalServiceNav = (slug, cfg) => [
  { label: 'New Rate Request', icon: FilePlus,      to: `/internal/${slug}/new` },
  { label: cfg.nav?.openRequests ?? 'Open Requests', icon: ClipboardList, to: `/internal/${slug}/requests` },
  { label: 'Rates',            icon: LineChart,     to: `/internal/${slug}/rates` },
  { label: 'Upload Rates',     icon: Upload,        to: `/internal/${slug}/upload` },
  // Apply Rates is an ocean-specific tool (DRAY.md §3a) — only in the ocean group
  ...(slug === 'ocean' ? [{ label: 'Apply Rates', icon: Route, to: '/internal/apply' }] : []),
]

const forwarderServiceNav = (slug, cfg) => [
  // The service's own mark (Ship / Truck) — otherwise both groups read identically.
  { label: 'Open Requests', icon: cfg.icon, to: `/forwarder/${slug}/lanes` },
  { label: 'Active Rates',  icon: FileText, to: `/forwarder/${slug}/submissions` },
]

/* ─── Shared nav item ────────────────────────────────────────────────── */

function NavItem({ to, icon: Icon, label, collapsed, end, onClick, tooltip }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      title={collapsed ? (tooltip ?? label) : undefined}
      className={({ isActive }) =>
        [
          'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150',
          isActive
            ? 'bg-harbor-800/80 text-white'
            : 'text-harbor-200/80 hover:bg-harbor-800/50 hover:text-white',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          {/* Active accent rail */}
          <span
            className={[
              'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-signal-500 transition-all duration-200',
              isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-40',
            ].join(' ')}
          />
          <Icon
            size={18}
            strokeWidth={isActive ? 2.25 : 1.75}
            className={[
              'shrink-0 transition-colors',
              isActive ? 'text-signal-400' : 'text-harbor-300 group-hover:text-signal-300',
            ].join(' ')}
          />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  )
}

/** Service group header — uppercase mono label + hairline (DRAY.md §3a).
    Collapsed rail: the label hides but the hairline still separates groups. */
function GroupHeader({ label, collapsed }) {
  if (collapsed) {
    return <div className="mx-2 my-2 h-px bg-white/10" />
  }
  return (
    <div className="flex items-center gap-2 px-3 pt-4 pb-1">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-harbor-400">
        {label}
      </span>
      <span className="h-px flex-1 bg-white/10" />
    </div>
  )
}

/* ─── Sidebar ─────────────────────────────────────────────────────────── */

export default function Sidebar({ open, onToggle, isMobile, onNavClick }) {
  const { role, services } = useAuth()
  const isForwarder = role === ROLES.FORWARDER
  const roleLabel = isForwarder ? ROLE_LABELS.forwarder : ROLE_LABELS.internal

  const dashboard = {
    label: 'Dashboard',
    icon: LayoutDashboard,
    to: isForwarder ? '/forwarder' : '/internal',
    end: true,
  }

  // Cross-service internal tools that belong to neither the Ocean nor Drayage group —
  // they sit ungrouped, right under Dashboard (DRAY.md §3a "shared, ungrouped" slot).
  const topLevel = isForwarder
    ? []
    : [
        { label: 'Bookings', icon: Container, to: '/internal/bookings' },
        { label: 'Analytics', icon: TrendingUp, to: '/internal/analytics' },
      ]

  // One stacked section per accessible service (order = serviceConfig order)
  const groups = services
    .filter((slug) => serviceConfig[slug])
    .map((slug) => ({
      slug,
      label: serviceConfig[slug].label,
      items: isForwarder
        ? forwarderServiceNav(slug, serviceConfig[slug])
        : internalServiceNav(slug, serviceConfig[slug]),
    }))

  /*
    THE COLLAPSED RAIL IS SIZED BY THE BRAND SLOT, not the nav icons.

    It was w-16 (64px) with a 16px-padded brand row, which left 32px of usable width. That was fine
    for a 36px slot only because the slot overflowed quietly into the padding; at 51.84px the aside's
    `overflow-hidden` started cutting the mark in half.

    72px is not arbitrary: the nav below insets 10px from each rail edge (nav px-2.5), so a 51.84px
    slot centred in 72px lands at 10.08px and lines up with the icons under it. Sizing the rail to
    the brand rather than cramming the brand into the rail is what keeps that column straight.
  */
  const desktopClasses = open ? 'w-60' : 'w-[4.5rem]'
  const mobileClasses = open
    ? 'fixed inset-y-0 left-0 z-40 w-60 shadow-2xl'
    : 'fixed inset-y-0 left-0 z-40 w-60 -translate-x-full'

  return (
    <aside
      className={[
        'grain relative flex h-full shrink-0 flex-col overflow-hidden bg-harbor-mesh text-white shadow-rail transition-all duration-200',
        isMobile ? mobileClasses : `relative ${desktopClasses}`,
      ].join(' ')}
    >
      {/* Faint nautical grid wash */}
      <div className="pointer-events-none absolute inset-0 bg-chart-grid bg-[size:22px_22px] opacity-60" />

      {/*
        Brand lockup. Open, it keeps the 16px inset that pins the mark to the same spot as
        Schedules and Planner. Collapsed, the padding goes and the slot centres itself in the
        narrow rail — 16px of padding either side cannot coexist with a 51.84px slot in a 72px
        column, and it was the padding, not the width, that did the clipping.
      */}
      <div
        className={[
          'relative flex h-16 items-center border-b border-white/5',
          open ? 'px-4' : 'justify-center px-0',
        ].join(' ')}
      >
        <BrandMark showText={open} />
      </div>

      {/* Role badge */}
      {open && (
        <div className="relative px-4 pt-4 pb-1">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-harbor-200 ring-1 ring-inset ring-white/10">
            <span className="h-1.5 w-1.5 rounded-full bg-sea-400" />
            {roleLabel}
          </span>
        </div>
      )}

      {/* Nav: Dashboard, then one stacked section per service (§3a) */}
      <nav className="relative flex-1 overflow-y-auto scrollbar-rail px-2.5 py-3">
        <NavItem collapsed={!open} onClick={onNavClick} {...dashboard} />
        {topLevel.map((item) => (
          <NavItem key={item.to} collapsed={!open} onClick={onNavClick} {...item} />
        ))}
        {groups.map((group) => (
          <div key={group.slug}>
            <GroupHeader label={group.label} collapsed={!open} />
            <div className="space-y-1">
              {group.items.map((item) => (
                <NavItem
                  key={item.to}
                  collapsed={!open}
                  onClick={onNavClick}
                  tooltip={`${group.label} · ${item.label}`}
                  {...item}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Collapse toggle — desktop only */}
      {!isMobile && (
        <button
          onClick={onToggle}
          className="absolute -right-3 top-20 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-harbor-700 bg-harbor-800 text-harbor-200 shadow-md transition-colors hover:bg-harbor-700 hover:text-signal-300"
          aria-label={open ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {open ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
        </button>
      )}

      {/* Footer */}
      <div className="relative border-t border-white/5 p-3">
        {open ? (
          <p className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-harbor-400">
            Rate Platform
          </p>
        ) : (
          <div className="h-3" />
        )}
      </div>
    </aside>
  )
}
