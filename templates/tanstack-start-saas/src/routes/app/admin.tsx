import { createFileRoute, redirect } from '@tanstack/react-router'
import * as React from 'react'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'

export const Route = createFileRoute('/app/admin')({
  beforeLoad: ({ context }) => {
    if (context.user && (context.user as any).role !== 'admin') {
      throw redirect({ to: '/app' })
    }
  },
  component: AdminOverviewPage,
})

function AdminOverviewPage() {
  const [data, setData] = React.useState<any>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/trpc/admin.overview')
      .then((res) => {
        if (!res.ok) throw new Error('Forbidden or failed to load admin data')
        return res.json()
      })
      .then((resData) => {
        setData(resData?.result?.data || resData)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center space-x-3">
          <h1 className="font-display text-3xl font-bold tracking-tight">Admin Overview</h1>
          <Badge variant="accent">Role: Admin</Badge>
        </div>
        <p className="text-sm text-[#17211B]/70 mt-1">
          Platform-wide studio metrics, project delivery status, and user statistics.
        </p>
      </div>

      {error ? (
        <Card className="p-6 border-red-300 bg-red-50 text-red-900">
          <CardTitle className="text-[#17211B]">Access Error</CardTitle>
          <CardDescription className="text-[#17211B]/80">{error}</CardDescription>
        </Card>
      ) : loading ? (
        <Card className="p-6">
          <p className="text-sm text-[#17211B]/60">Loading admin metrics...</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary Metrics */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="p-5">
              <span className="text-xs font-mono uppercase text-[#17211B]/60">Total Users</span>
              <p className="font-display text-3xl font-bold mt-2">{data?.usersCount ?? 1}</p>
            </Card>
            <Card className="p-5">
              <span className="text-xs font-mono uppercase text-[#17211B]/60">Active Projects</span>
              <p className="font-display text-3xl font-bold mt-2">{data?.projectsCount ?? 0}</p>
            </Card>
            <Card className="p-5">
              <span className="text-xs font-mono uppercase text-[#17211B]/60">Open Tasks</span>
              <p className="font-display text-3xl font-bold mt-2">{data?.openTasksCount ?? 0}</p>
            </Card>
          </div>

          {/* Delivery & Projects Summary Table */}
          <Card className="p-6">
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-xl">System Delivery Pulse</CardTitle>
              <CardDescription>
                Overview of active studio delivery rails and project statuses.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[#17211B]/10 font-mono text-xs uppercase text-[#17211B]/60">
                    <tr>
                      <th className="py-2 pr-4">Metric</th>
                      <th className="py-2 px-4">Value</th>
                      <th className="py-2 pl-4">Delivery Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#17211B]/10">
                    <tr>
                      <td className="py-3 pr-4 font-medium">Platform Health</td>
                      <td className="py-3 px-4 text-[#315CF5] font-semibold">Optimal</td>
                      <td className="py-3 pl-4">
                        <Badge variant="default">Operational</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-4 font-medium">Active Delivery Rails</td>
                      <td className="py-3 px-4 font-mono">{data?.projectsCount ?? 0} active</td>
                      <td className="py-3 pl-4">
                        <Badge variant="primary">In production</Badge>
                      </td>
                    </tr>
                    <tr>
                      <td className="py-3 pr-4 font-medium">Pending Deliverables</td>
                      <td className="py-3 px-4 font-mono">{data?.openTasksCount ?? 0} items</td>
                      <td className="py-3 pl-4">
                        <Badge variant="accent">Client review</Badge>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
