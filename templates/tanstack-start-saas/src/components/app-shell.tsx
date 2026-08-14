import { Link, useNavigate } from '@tanstack/react-router'
import * as React from 'react'

import { signOut } from '~/lib/auth-client'

import { Button } from './ui/button'

export interface AppShellProps {
  children: React.ReactNode
  user?: {
    name?: string
    email?: string
    role?: string
  } | null
}

export function AppShell({ children, user }: AppShellProps) {
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOut()
    await navigate({ to: '/login' })
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#F6F3E9] text-[#17211B] md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full flex-col justify-between border-b border-[#17211B]/10 bg-[#FFFDF7] p-6 md:w-64 md:border-r md:border-b-0">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Link
              to="/"
              className="font-display text-2xl font-bold tracking-tight text-[#17211B]"
            >
              BunderSaaS
            </Link>
            <span className="rounded bg-[#DCEBDD] px-2 py-0.5 font-mono text-xs text-[#17211B]">
              CLIENT
            </span>
          </div>

          <nav className="flex flex-col space-y-1">
            <Link
              to="/app"
              activeProps={{ className: 'bg-[#DCEBDD] font-semibold' }}
              className="flex items-center rounded-[10px] px-3 py-2 text-sm text-[#17211B] transition-colors hover:bg-[#DCEBDD]/60"
            >
              Overview
            </Link>
            <Link
              to="/app/projects"
              activeProps={{ className: 'bg-[#DCEBDD] font-semibold' }}
              className="flex items-center rounded-[10px] px-3 py-2 text-sm text-[#17211B] transition-colors hover:bg-[#DCEBDD]/60"
            >
              Projects
            </Link>

            {user?.role === 'admin' && (
              <div className="mt-2 border-t border-[#17211B]/10 pt-4">
                <Link
                  to="/admin"
                  className="flex items-center rounded-[10px] px-3 py-2 text-xs font-semibold text-[#315CF5] transition-colors hover:bg-[#315CF5]/10"
                >
                  Admin Portal →
                </Link>
              </div>
            )}
          </nav>
        </div>

        <div className="space-y-3 border-t border-[#17211B]/10 pt-6">
          {user ? (
            <div className="space-y-1">
              <p className="truncate text-sm font-medium text-[#17211B]">
                {user.name || 'User'}
              </p>
              <p className="truncate text-xs text-[#17211B]/60">{user.email}</p>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignOut}
            className="w-full justify-start text-xs"
          >
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-6 md:p-10">
        <div className="mx-auto max-w-6xl space-y-6">{children}</div>
      </main>
    </div>
  )
}
