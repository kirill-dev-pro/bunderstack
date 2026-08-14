import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import * as React from 'react'

import type { Project } from '~/api'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { Input } from '~/components/ui/input'

export const Route = createFileRoute('/app/projects')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { api } = Route.useRouteContext()
  const navigate = useNavigate()

  const [projects, setProjects] = React.useState<Project[]>([])
  const [name, setName] = React.useState('')
  const [clientName, setClientName] = React.useState('')
  const [isPending, setIsPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

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

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setError(null)
    setIsPending(true)

    try {
      const created = await api.createProject.call({ name, clientName })
      setName('')
      setClientName('')

      void loadProjects()

      if (created.id) {
        await navigate({
          to: '/app/projects/$projectId',
          params: { projectId: created.id },
        })
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Projects
          </h1>
          <p className="text-sm text-[#17211B]/70 mt-1">
            Manage your creative studio client delivery workspaces.
          </p>
        </div>
      </div>

      {/* Create Project Card */}
      <Card className="p-6">
        <CardHeader className="p-0 pb-4">
          <CardTitle className="text-xl">Create a New Project</CardTitle>
          <CardDescription>
            Setup a new client delivery workspace with its own live delivery
            rail.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div role="alert" className="text-sm text-red-600 mb-4">
              {error}
            </div>
          )}
          <form
            onSubmit={handleCreateProject}
            className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-end"
          >
            <div className="sm:col-span-5 space-y-1.5">
              <label
                htmlFor="projectName"
                className="text-xs font-medium text-[#17211B]"
              >
                Project Name
              </label>
              <Input
                id="projectName"
                type="text"
                placeholder="e.g. Brand Refresh 2026"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div className="sm:col-span-5 space-y-1.5">
              <label
                htmlFor="clientName"
                className="text-xs font-medium text-[#17211B]"
              >
                Client Name (Optional)
              </label>
              <Input
                id="clientName"
                type="text"
                placeholder="e.g. Acme Corp"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={isPending || !name.trim()}
                className="w-full"
              >
                {isPending ? 'Creating...' : 'Create Project'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Projects List */}
      <div className="space-y-4">
        <h2 className="font-display text-xl font-semibold">
          Your Active Workspaces
        </h2>
        {projects.length === 0 ? (
          <Card className="p-8 text-center space-y-3">
            <CardTitle className="text-lg">No active projects</CardTitle>
            <CardDescription>
              Create your first project above to start tracking deliverables.
            </CardDescription>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((project) => (
              <Card
                key={project.id}
                className="hover:border-[#315CF5]/40 transition-colors"
              >
                <CardHeader className="p-5 pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">
                      <Link
                        to="/app/projects/$projectId"
                        params={{ projectId: project.id }}
                        className="hover:underline"
                      >
                        {project.name}
                      </Link>
                    </CardTitle>
                    <Badge>{project.status || 'in_progress'}</Badge>
                  </div>
                  <CardDescription className="text-xs">
                    Client: {project.clientName || 'Unassigned'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-5 pt-0 flex justify-end">
                  <Button variant="outline" size="sm" asChild>
                    <Link
                      to="/app/projects/$projectId"
                      params={{ projectId: project.id }}
                    >
                      Open Workspace →
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
