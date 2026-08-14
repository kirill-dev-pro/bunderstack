import { Link, useNavigate } from '@tanstack/react-router'
import * as React from 'react'

import { signOut } from '~/lib/auth-client'

import { Badge } from './ui/badge'
import { Button } from './ui/button'

export interface AdminShellProps {
  children: React.ReactNode
  user?: {
    name?: string
    email?: string
    role?: string
  } | null
}

export function AdminAppShell({ children, user }: AdminShellProps) {
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/login' })
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#17211B] text-[#FFFDF7] md:flex-row">
      {/* Admin Sidebar */}
      <aside className="flex w-full flex-col justify-between border-b border-[#FFFDF7]/15 bg-[#0F1713] p-6 md:w-64 md:border-r md:border-b-0">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Link
              to="/"
              className="font-display text-2xl font-bold tracking-tight text-[#FFFDF7]"
            >
              BunderSaaS
            </Link>
            <Badge variant="accent" className="font-mono text-xs">
              ADMIN
            </Badge>
          </div>

          <nav className="flex flex-col space-y-1">
            <Link
              to="/admin"
              activeProps={{
                className: 'bg-[#315CF5] text-white font-semibold',
              }}
              className="flex items-center rounded-[10px] px-3 py-2 text-sm text-[#FFFDF7]/80 transition-colors hover:bg-[#FFFDF7]/10"
            >
              System Pulse
            </Link>
            <Link
              to="/admin/users"
              activeProps={{
                className: 'bg-[#315CF5] text-white font-semibold',
              }}
              className="flex items-center rounded-[10px] px-3 py-2 text-sm text-[#FFFDF7]/80 transition-colors hover:bg-[#FFFDF7]/10"
            >
              User Management
            </Link>
            <Link
              to="/admin/projects"
              activeProps={{
                className: 'bg-[#315CF5] text-white font-semibold',
              }}
              className="flex items-center rounded-[10px] px-3 py-2 text-sm text-[#FFFDF7]/80 transition-colors hover:bg-[#FFFDF7]/10"
            >
              All Projects
            </Link>
            <div className="mt-2 border-t border-[#FFFDF7]/10 pt-4">
              <Link
                to="/app"
                className="flex items-center rounded-[10px] px-3 py-2 text-xs text-[#DCEBDD] transition-colors hover:bg-[#FFFDF7]/10"
              >
                ← Client Workspace
              </Link>
            </div>
          </nav>
        </div>

        <div className="space-y-3 border-t border-[#FFFDF7]/15 pt-6">
          {user ? (
            <div className="space-y-1">
              <p className="truncate text-sm font-medium text-[#FFFDF7]">
                {user.name || 'Admin User'}
              </p>
              <p className="truncate text-xs text-[#FFFDF7]/60">{user.email}</p>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignOut}
            className="w-full justify-start border-[#FFFDF7]/20 text-xs text-[#FFFDF7] hover:bg-[#FFFDF7]/10"
          >
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Admin Content Area */}
      <main className="flex-1 overflow-y-auto p-6 md:p-10">
        <div className="mx-auto max-w-6xl space-y-6">{children}</div>
      </main>
    </div>
  )
}
