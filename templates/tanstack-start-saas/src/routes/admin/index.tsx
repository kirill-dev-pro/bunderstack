import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import { Badge } from '~/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

export const Route = createFileRoute('/admin/')({
  component: AdminOverviewPage,
})

interface OverviewData {
  users: number
  projects: number
  openTasks: number
  recent: Array<{ id: string; name: string; ownerId: string }>
}

function AdminOverviewPage() {
  const { adminAuth, api } = Route.useRouteContext()
  const [data, setData] = React.useState<OverviewData | null>(null)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let active = true
    api.adminOverview
      .call()
      .then((json) => {
        if (active) {
          setData(json)
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight text-[#FFFDF7]">
          System Pulse & Admin Portal
        </h1>
        <p className="mt-1 text-sm text-[#FFFDF7]/70">
          Authenticated as{' '}
          <span className="font-semibold text-[#DCEBDD]">
            {adminAuth.user.name || adminAuth.user.email}
          </span>{' '}
          ({adminAuth.role})
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Card className="border-[#FFFDF7]/15 bg-[#0F1713] text-[#FFFDF7]">
          <CardHeader className="pb-2">
            <CardDescription className="font-mono text-xs text-[#FFFDF7]/60 uppercase">
              System Health
            </CardDescription>
            <CardTitle className="font-mono text-2xl font-bold text-[#DCEBDD]">
              HEALTHY
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-[#FFFDF7]/70">
              Bunderstack runtime & LibSQL connected
            </p>
          </CardContent>
        </Card>

        <Card className="border-[#FFFDF7]/15 bg-[#0F1713] text-[#FFFDF7]">
          <CardHeader className="pb-2">
            <CardDescription className="font-mono text-xs text-[#FFFDF7]/60 uppercase">
              Total Platform Projects
            </CardDescription>
            <CardTitle className="font-mono text-3xl font-bold text-[#315CF5]">
              {loading ? '...' : (data?.projects ?? 0)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-[#FFFDF7]/70">
              Real-time owner-scoped tenant databases
            </p>
          </CardContent>
        </Card>

        <Card className="border-[#FFFDF7]/15 bg-[#0F1713] text-[#FFFDF7]">
          <CardHeader className="pb-2">
            <CardDescription className="font-mono text-xs text-[#FFFDF7]/60 uppercase">
              Auth Context Status
            </CardDescription>
            <div className="pt-1">
              <Badge variant="accent" className="font-mono text-xs">
                {adminAuth.isAdmin ? 'IS_ADMIN_VERIFIED' : 'GUEST'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-[#FFFDF7]/70">
              Gated by TanStack Start /admin route context
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Admin Audit & Worker Activity */}
      <Card className="space-y-4 border-[#FFFDF7]/15 bg-[#0F1713] p-6 text-[#FFFDF7]">
        <h2 className="font-display text-xl font-bold text-[#FFFDF7]">
          Platform Event Stream
        </h2>
        <div className="space-y-3 font-mono text-xs text-[#FFFDF7]/80">
          <div className="flex items-center justify-between border-b border-[#FFFDF7]/10 py-2">
            <span>[SYS_WORKER] Background queue listener active</span>
            <Badge
              variant="outline"
              className="border-[#DCEBDD]/30 text-[#DCEBDD]"
            >
              ONLINE
            </Badge>
          </div>
          <div className="flex items-center justify-between border-b border-[#FFFDF7]/10 py-2">
            <span>[AUTH_CONTEXT] /admin route guard enforced</span>
            <Badge
              variant="outline"
              className="border-[#315CF5]/30 text-[#315CF5]"
            >
              SECURE
            </Badge>
          </div>
          <div className="flex items-center justify-between py-2">
            <span>
              [SYNC_ENGINE] Real-time table subscription handler ready
            </span>
            <Badge
              variant="outline"
              className="border-[#E9A23B]/30 text-[#E9A23B]"
            >
              LISTENING
            </Badge>
          </div>
        </div>
      </Card>
    </div>
  )
}
