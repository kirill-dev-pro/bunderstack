import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'

import type { Project } from '~/api'

import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'

export const Route = createFileRoute('/admin/projects')({
  component: AdminProjectsPage,
})

function AdminProjectsPage() {
  const { api } = Route.useRouteContext()
  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let active = true
    api.projects.list
      .call({ limit: 100 })
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
        <p className="mt-1 text-sm text-[#FFFDF7]/70">
          Global view of all client workspace projects
        </p>
      </div>

      <Card className="border-[#FFFDF7]/15 bg-[#0F1713] text-[#FFFDF7]">
        <CardHeader>
          <CardTitle className="text-lg font-bold text-[#FFFDF7]">
            All Registered Projects ({projects.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-[#FFFDF7]/60">
              Loading platform projects...
            </p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-[#FFFDF7]/60">
              No projects created yet across the platform.
            </p>
          ) : (
            <div className="space-y-3 font-mono text-sm">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-[8px] border border-[#FFFDF7]/10 bg-[#17211B] p-3"
                >
                  <div>
                    <p className="font-sans font-semibold text-[#FFFDF7]">
                      {p.name}
                    </p>
                    <p className="text-xs text-[#FFFDF7]/60">
                      Owner ID: {p.ownerId || 'N/A'}
                    </p>
                  </div>
                  <span className="text-xs text-[#DCEBDD] uppercase">
                    {p.status || 'ACTIVE'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
