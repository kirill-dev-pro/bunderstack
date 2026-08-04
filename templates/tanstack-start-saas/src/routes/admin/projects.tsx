import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export const Route = createFileRoute('/admin/projects')({
  component: AdminProjectsPage,
})

function AdminProjectsPage() {
  const { api } = Route.useRouteContext()
  const [projects, setProjects] = React.useState<any[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let active = true
    api.projects.table
      .list()
      .then((res) => {
        if (active) {
          setProjects(res.items || [])
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
          Platform Projects Oversight
        </h1>
        <p className="text-sm text-[#FFFDF7]/70 mt-1">
          Global view of all client workspace projects
        </p>
      </div>

      <Card className="bg-[#0F1713] border-[#FFFDF7]/15 text-[#FFFDF7]">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-[#FFFDF7]">
            All Registered Projects ({projects.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[#FFFDF7]/60">Loading platform projects...</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-[#FFFDF7]/60">No projects created yet across the platform.</p>
          ) : (
            <div className="space-y-3 font-mono text-sm">
              {projects.map((p) => (
                <div key={p.id} className="p-3 rounded-[8px] bg-[#17211B] border border-[#FFFDF7]/10 flex items-center justify-between">
                  <div>
                    <p className="font-sans font-semibold text-[#FFFDF7]">{p.name}</p>
                    <p className="text-xs text-[#FFFDF7]/60">Owner ID: {p.ownerId || 'N/A'}</p>
                  </div>
                  <span className="text-xs text-[#DCEBDD] uppercase">{p.status || 'ACTIVE'}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
