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
    await navigate({ to: '/login' as any })
  }

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#17211B] text-[#FFFDF7]">
      {/* Admin Sidebar */}
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-[#FFFDF7]/15 bg-[#0F1713] p-6 flex flex-col justify-between">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <Link to="/" className="font-display text-2xl font-bold tracking-tight text-[#FFFDF7]">
              BunderSaaS
            </Link>
            <Badge variant="accent" className="font-mono text-xs">
              ADMIN
            </Badge>
          </div>

          <nav className="flex flex-col space-y-1">
            <Link
              to="/admin"
              activeProps={{ className: 'bg-[#315CF5] text-white font-semibold' }}
              className="flex items-center px-3 py-2 rounded-[10px] text-sm text-[#FFFDF7]/80 hover:bg-[#FFFDF7]/10 transition-colors"
            >
              System Pulse
            </Link>
            <Link
              to="/admin/users"
              activeProps={{ className: 'bg-[#315CF5] text-white font-semibold' }}
              className="flex items-center px-3 py-2 rounded-[10px] text-sm text-[#FFFDF7]/80 hover:bg-[#FFFDF7]/10 transition-colors"
            >
              User Management
            </Link>
            <Link
              to="/admin/projects"
              activeProps={{ className: 'bg-[#315CF5] text-white font-semibold' }}
              className="flex items-center px-3 py-2 rounded-[10px] text-sm text-[#FFFDF7]/80 hover:bg-[#FFFDF7]/10 transition-colors"
            >
              All Projects
            </Link>
            <div className="pt-4 border-t border-[#FFFDF7]/10 mt-2">
              <Link
                to="/app"
                className="flex items-center px-3 py-2 rounded-[10px] text-xs text-[#DCEBDD] hover:bg-[#FFFDF7]/10 transition-colors"
              >
                ← Client Workspace
              </Link>
            </div>
          </nav>
        </div>

        <div className="pt-6 border-t border-[#FFFDF7]/15 space-y-3">
          {user ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-[#FFFDF7] truncate">{user.name || 'Admin User'}</p>
              <p className="text-xs text-[#FFFDF7]/60 truncate">{user.email}</p>
            </div>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignOut}
            className="w-full justify-start text-xs border-[#FFFDF7]/20 text-[#FFFDF7] hover:bg-[#FFFDF7]/10"
          >
            Sign Out
          </Button>
        </div>
      </aside>

      {/* Admin Content Area */}
      <main className="flex-1 p-6 md:p-10 overflow-y-auto">
        <div className="max-w-6xl mx-auto space-y-6">
          {children}
        </div>
      </main>
    </div>
  )
}
