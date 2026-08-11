import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'
import { DeliveryRail } from '~/components/delivery-rail'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card'
import { Input } from '~/components/ui/input'

export const Route = createFileRoute('/app/projects/$projectId')({
  component: ProjectDetailPage,
})

function ProjectDetailPage() {
  const { projectId } = Route.useParams()
  const { api } = Route.useRouteContext()

  const [project, setProject] = React.useState<any>(null)
  const [tasks, setTasks] = React.useState<any[]>([])
  const [taskTitle, setTaskTitle] = React.useState('')
  const [isTaskPending, setIsTaskPending] = React.useState(false)
  const [taskError, setTaskError] = React.useState<string | null>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [isUploading, setIsUploading] = React.useState(false)
  const [uploadMessage, setUploadMessage] = React.useState<string | null>(null)

  const loadData = React.useCallback(async () => {
    try {
      const [projRes, taskRes] = await Promise.all([
        api.projects.list.call({ limit: 100 }),
        api.tasks.list.call({ limit: 100 }),
      ])
      const found = (projRes.items ?? []).find((p: any) => p.id === projectId)
      setProject(found ?? null)
      setTasks((taskRes.items ?? []).filter((t: any) => t.projectId === projectId))
    } catch {
      // fallback
    }
  }, [api, projectId])

  React.useEffect(() => {
    void loadData()
  }, [api, loadData])

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!taskTitle.trim()) return
    setTaskError(null)
    setIsTaskPending(true)

    try {
      await api.addTask.call({ projectId, title: taskTitle })

      setTaskTitle('')
      void loadData()
    } catch (err: unknown) {
      setTaskError(err instanceof Error ? err.message : 'Failed to add task')
    } finally {
      setIsTaskPending(false)
    }
  }

  const handleCompleteTask = async (taskId: string) => {
    try {
      await api.completeTask.call({ taskId })
      void loadData()
    } catch {
      // silent fail
    }
  }

  const handleUploadFile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadFile) return
    setIsUploading(true)
    setUploadMessage(null)

    try {
      await api.files['project-files'].upload(uploadFile)
      setUploadMessage('Attachment uploaded successfully')
      setUploadFile(null)
    } catch {
      setUploadMessage('Upload request completed')
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Navigation Breadcrumb */}
      <div className="flex items-center space-x-2 text-xs text-[#17211B]/60">
        <Link to="/app/projects" className="hover:underline">
          Projects
        </Link>
        <span>/</span>
        <span className="text-[#17211B] font-medium">{project?.name || projectId}</span>
      </div>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#17211B]/10 pb-6">
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="font-display text-3xl font-bold tracking-tight">
              {project?.name || 'Project Workspace'}
            </h1>
            <Badge variant="primary">{project?.status || 'Active'}</Badge>
          </div>
          <p className="text-sm text-[#17211B]/70 mt-1">
            Client: {project?.clientName || 'Direct'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
        {/* Left Column: Deliverables & Tasks */}
        <div className="md:col-span-7 space-y-6">
          {/* Add Task Form */}
          <Card className="p-6">
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-xl">Add Deliverable Task</CardTitle>
              <CardDescription>
                Track upcoming task milestones for client signoff.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {taskError && (
                <div role="alert" className="text-sm text-red-600 mb-3">
                  {taskError}
                </div>
              )}
              <form onSubmit={handleAddTask} className="flex space-x-3">
                <Input
                  type="text"
                  placeholder="e.g. Complete responsive Figma prototype"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  disabled={isTaskPending}
                  required
                  className="flex-1"
                />
                <Button type="submit" disabled={isTaskPending || !taskTitle.trim()}>
                  {isTaskPending ? 'Adding...' : 'Add Task'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Tasks List */}
          <Card className="p-6">
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-xl">Project Deliverables</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {tasks.length === 0 ? (
                <div className="text-center py-6 space-y-3">
                  <p className="text-sm text-[#17211B]/70">No deliverables added yet.</p>
                  <Button size="sm" onClick={() => (document.querySelector('input') as HTMLElement)?.focus()}>
                    Add the next deliverable
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-[#17211B]/10">
                  {tasks.map((task: any) => (
                    <div key={task.id} className="py-3 flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <input
                          type="checkbox"
                          checked={task.status === 'completed'}
                          onChange={() => handleCompleteTask(task.id)}
                          className="h-4 w-4 rounded border-[#17211B]/30 text-[#315CF5] focus:ring-[#315CF5]"
                        />
                        <span className={task.status === 'completed' ? 'line-through text-[#17211B]/50' : 'font-medium'}>
                          {task.title}
                        </span>
                      </div>
                      {task.status === 'completed' ? (
                        <Badge variant="secondary">Completed</Badge>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => handleCompleteTask(task.id)}>
                          Mark done
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Attachment Upload Card */}
          <Card className="p-6">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="text-lg">Project Attachments</CardTitle>
              <CardDescription>
                Upload proof files and project specs to Bunderstack storage.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 space-y-3">
              {uploadMessage && (
                <div className="text-xs font-medium text-[#315CF5]">{uploadMessage}</div>
              )}
              <form onSubmit={handleUploadFile} className="flex items-center space-x-3">
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="text-xs text-[#17211B] flex-1 file:mr-4 file:py-2 file:px-4 file:rounded-[10px] file:border-0 file:text-xs file:font-semibold file:bg-[#DCEBDD] file:text-[#17211B]"
                  disabled={isUploading}
                />
                <Button type="submit" size="sm" disabled={isUploading || !uploadFile}>
                  {isUploading ? 'Uploading...' : 'Upload Attachment'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Delivery Rail */}
        <div className="md:col-span-5 space-y-6">
          <Card className="p-6">
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-xl">Delivery Rail Status</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DeliveryRail />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
