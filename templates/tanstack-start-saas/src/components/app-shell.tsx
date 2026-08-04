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
    await navigate({ to: '/login' as any })
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#F6F3E9] text-[#17211B]">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-[#17211B]/10 bg-[#FFFDF7] p-6 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Link to="/" className="font-display text-2xl font-bold tracking-tight text-[#17211B]">
              BunderSaaS
            </Link>
            <span className="font-mono text-xs px-2 py-0.5 rounded bg-[#DCEBDD] text-[#17211B]">
              CLIENT
            </span>
          </div>

          <nav className="flex flex-col space-y-1">
            <Link
              to="/app"
              activeProps={{ className: 'bg-[#DCEBDD] font-semibold' }}
              className="flex items-center px-3 py-2 rounded-[10px] text-sm text-[#17211B] hover:bg-[#DCEBDD]/60 transition-colors"
            >
              Overview
            </Link>
            <Link
              to="/app/projects"
              activeProps={{ className: 'bg-[#DCEBDD] font-semibold' }}
              className="flex items-center px-3 py-2 rounded-[10px] text-sm text-[#17211B] hover:bg-[#DCEBDD]/60 transition-colors"
            >
              Projects
            </Link>

            {user?.role === 'admin' && (
              <div className="pt-4 border-t border-[#17211B]/10 mt-2">
                <Link
                  to="/admin"
                  className="flex items-center px-3 py-2 rounded-[10px] text-xs font-semibold text-[#315CF5] hover:bg-[#315CF5]/10 transition-colors"
                >
                  Admin Portal →
                </Link>
              </div>
            )}
          </nav>
        </div>

        <div className="pt-6 border-t border-[#17211B]/10 space-y-3">
          {user ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-[#17211B] truncate">{user.name || 'User'}</p>
              <p className="text-xs text-[#17211B]/60 truncate">{user.email}</p>
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
      <main className="flex-1 p-6 md:p-10 overflow-y-auto">
        <div className="max-w-6xl mx-auto space-y-6">
          {children}
        </div>
      </main>
    </div>
  )
}
