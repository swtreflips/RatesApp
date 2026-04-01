import React, { useState, useEffect } from 'react'
import { useAuth } from './providers/AuthProvider'
import TopNav from '../components/shell/TopNav'
import Sidebar from '../components/shell/Sidebar'
import RoleRouter from './RoleRouter'

/* ── mobile breakpoint hook ───────────────────────────────────────────── */

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const handler = (e) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])
  return isMobile
}

/**
 * The shared application shell.
 * Composes TopNav + Sidebar + main content area.
 * Mounts RoleRouter in the main content slot.
 * Does not contain any requester or provider business logic.
 */
export default function Shell() {
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile)

  // Auto-close sidebar when switching to mobile
  useEffect(() => {
    if (isMobile) setSidebarOpen(false)
    else setSidebarOpen(true)
  }, [isMobile])

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(o => !o)}
        isMobile={isMobile}
        onNavClick={() => isMobile && setSidebarOpen(false)}
      />

      {/* Right panel: top nav + page content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopNav onMenuToggle={() => setSidebarOpen(o => !o)} />

        {/* Main scrollable content area */}
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="min-h-full px-6 py-6">
            <RoleRouter />
          </div>
        </main>
      </div>
    </div>
  )
}
