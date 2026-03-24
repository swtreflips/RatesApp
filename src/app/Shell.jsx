import React, { useState } from 'react'
import { useAuth } from './providers/AuthProvider'
import TopNav from '../components/shell/TopNav'
import Sidebar from '../components/shell/Sidebar'
import RoleRouter from './RoleRouter'

/**
 * The shared application shell.
 * Composes TopNav + Sidebar + main content area.
 * Mounts RoleRouter in the main content slot.
 * Does not contain any requester or provider business logic.
 */
export default function Shell() {
  const [sidebarOpen, setSidebarOpen] = useState(true)

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar */}
      <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(o => !o)} />

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
