import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import type { Project } from '~/api'

import { DeliveryRail } from '~/components/delivery-rail'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

export const Route = createFileRoute('/app/')({
  component: DashboardOverview,
})

function DashboardOverview() {
  const { clientAuth, api } = Route.useRouteContext()
  const user = clientAuth?.user
  const [projects, setProjects] = React.useState<Project[]>([])

  const loadProjects = React.useCallback(async () => {
    try {
      const res = await api.projects.list.call({ limit: 100 })
      setProjects(res.items ?? [])
    } catch {
      // fallback
    }
  }, [api])

  React.useEffect(() => {
    void loadProjects()
  }, [api, loadProjects])

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Welcome back, {user?.name || 'Client'}
        </h1>
        <p className="mt-1 text-sm text-[#17211B]/70">
          Here is your client workspace delivery rhythm and active projects.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
        {/* Left Column - Active Projects */}
        <div className="space-y-6 md:col-span-7">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-semibold">
              Active Projects
            </h2>
            <Button size="sm" asChild>
              <Link to="/app/projects">Create your first project</Link>
            </Button>
          </div>

          {projects.length === 0 ? (
            <Card className="space-y-4 p-8 text-center">
              <CardTitle className="text-lg">No projects yet</CardTitle>
              <CardDescription>
                Get started by creating your first client delivery workspace.
              </CardDescription>
              <Button asChild>
                <Link to="/app/projects">Create your first project</Link>
              </Button>
            </Card>
          ) : (
            <div className="space-y-4">
              {projects.map((project) => (
                <Card
                  key={project.id}
                  className="transition-colors hover:border-[#315CF5]/40"
                >
                  <CardHeader className="flex flex-row items-center justify-between p-5 pb-2">
                    <div>
                      <CardTitle className="text-lg">
                        <Link
                          to="/app/projects/$projectId"
                          params={{ projectId: project.id }}
                          className="hover:underline"
                        >
                          {project.name}
                        </Link>
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Client: {project.clientName || 'Direct'}
                      </CardDescription>
                    </div>
                    <Badge
                      variant={
                        project.status === 'ready' ? 'secondary' : 'default'
                      }
                    >
                      {project.status || 'in_progress'}
                    </Badge>
                  </CardHeader>
                  <CardContent className="flex items-center justify-between p-5 pt-2 text-xs text-[#17211B]/60">
                    <span>
                      Due:{' '}
                      {project.dueAt
                        ? new Date(project.dueAt).toLocaleDateString()
                        : 'Flexible'}
                    </span>
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        to="/app/projects/$projectId"
                        params={{ projectId: project.id }}
                      >
                        Open workspace →
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Right Column - Delivery Rail & Live Pulse */}
        <div className="space-y-6 md:col-span-5">
          <h2 className="font-display font-display text-xl font-semibold">
            Delivery Rail Status
          </h2>
          <DeliveryRail />
        </div>
      </div>
    </div>
  )
}
