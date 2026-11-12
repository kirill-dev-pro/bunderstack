import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import type { Attachment, Project, Task } from '~/api'

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
import { Input } from '~/components/ui/input'

export const Route = createFileRoute('/app/projects/$projectId')({
  component: ProjectDetailPage,
})

function ProjectDetailPage() {
  const { projectId } = Route.useParams()
  const { api } = Route.useRouteContext()

  const [project, setProject] = React.useState<Project | null>(null)
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [inboxAddress, setInboxAddress] = React.useState<string | null>(null)
  const [taskTitle, setTaskTitle] = React.useState('')
  const [isTaskPending, setIsTaskPending] = React.useState(false)
  const [taskError, setTaskError] = React.useState<string | null>(null)
  const [uploadFile, setUploadFile] = React.useState<File | null>(null)
  const [isUploading, setIsUploading] = React.useState(false)
  const [uploadMessage, setUploadMessage] = React.useState<string | null>(null)
  const [digestMessage, setDigestMessage] = React.useState<string | null>(null)
  const [coverMessage, setCoverMessage] = React.useState<string | null>(null)

  const loadData = React.useCallback(async () => {
    try {
      const [projRes, taskRes, attachmentRes] = await Promise.all([
        api.projects.list.call({ limit: 100 }),
        api.tasks.list.call({ limit: 100, filters: { projectId } }),
        api.attachments.list.call({ limit: 100, filters: { projectId } }),
      ])
      const found = projRes.items.find((project) => project.id === projectId)
      setProject(found ?? null)
      setTasks(taskRes.items)
      setAttachments(attachmentRes.items)
    } catch {
      // fallback
    }
  }, [api, projectId])

  React.useEffect(() => {
    void loadData()
    api.projectInbox
      .call({ projectId })
      .then(({ address }) => setInboxAddress(address))
      .catch(() => setInboxAddress(null))
  }, [api, loadData, projectId])

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

  // Two steps: the browser uploads to the private bucket, then the server
  // checks the file is the caller's and links it to the project.
  const handleUploadFile = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadFile) return
    setIsUploading(true)
    setUploadMessage(null)

    try {
      const { fileId } = await api.files['project-files'].upload(uploadFile)
      await api.attachFile.call({ projectId, fileId })
      setUploadFile(null)
      void loadData()
    } catch (err: unknown) {
      setUploadMessage(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsUploading(false)
    }
  }

  const handleRemoveAttachment = async (attachmentId: string) => {
    await api.removeAttachment.call({ attachmentId }).catch(() => {})
    void loadData()
  }

  const handleCover = async (file: File | undefined) => {
    if (!file) return
    setCoverMessage(null)
    try {
      const { fileId } = await api.files.public.upload(file)
      setProject(await api.setProjectCover.call({ projectId, fileId }))
    } catch (err: unknown) {
      setCoverMessage(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const handleDigest = async () => {
    setDigestMessage(null)
    try {
      await api.requestDigest.call({ projectId })
      setDigestMessage('Queued. The worker emails it to you in a moment.')
    } catch (err: unknown) {
      setDigestMessage(err instanceof Error ? err.message : 'Not queued')
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
        <span className="font-medium text-[#17211B]">
          {project?.name || projectId}
        </span>
      </div>

      {/* Cover, served from the public bucket and resized on the fly */}
      {project?.coverUrl && (
        <img
          src={`${project.coverUrl}?w=1200&format=webp`}
          alt=""
          className="h-40 w-full rounded-[16px] object-cover"
        />
      )}

      {/* Header */}
      <div className="flex flex-col justify-between gap-4 border-b border-[#17211B]/10 pb-6 md:flex-row md:items-center">
        <div>
          <div className="flex items-center space-x-3">
            <h1 className="font-display text-3xl font-bold tracking-tight">
              {project?.name || 'Project Workspace'}
            </h1>
            <Badge variant="primary">{project?.status || 'Active'}</Badge>
          </div>
          <p className="mt-1 text-sm text-[#17211B]/70">
            Client: {project?.clientName || 'Direct'}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <div className="flex gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center rounded-[10px] border border-[#17211B]/15 px-3 text-sm font-medium hover:bg-[#DCEBDD]/50">
              {project?.coverUrl ? 'Change cover' : 'Add cover'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="sr-only"
                onChange={(e) => void handleCover(e.target.files?.[0])}
              />
            </label>
            <Button size="sm" onClick={() => void handleDigest()}>
              Email me a digest
            </Button>
          </div>
          {(digestMessage || coverMessage) && (
            <p className="text-xs text-[#17211B]/70">
              {digestMessage || coverMessage}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-12">
        {/* Left Column: Deliverables & Tasks */}
        <div className="space-y-6 md:col-span-7">
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
                <div role="alert" className="mb-3 text-sm text-red-600">
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
                <Button
                  type="submit"
                  disabled={isTaskPending || !taskTitle.trim()}
                >
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
                <div className="space-y-3 py-6 text-center">
                  <p className="text-sm text-[#17211B]/70">
                    No deliverables added yet.
                  </p>
                  <Button
                    size="sm"
                    onClick={() =>
                      document.querySelector<HTMLInputElement>('input')?.focus()
                    }
                  >
                    Add the next deliverable
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-[#17211B]/10">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className="flex items-center justify-between py-3"
                    >
                      <div className="flex items-center space-x-3">
                        <input
                          type="checkbox"
                          checked={task.status === 'done'}
                          onChange={() => handleCompleteTask(task.id)}
                          className="h-4 w-4 rounded border-[#17211B]/30 text-[#315CF5] focus:ring-[#315CF5]"
                        />
                        <span
                          className={
                            task.status === 'done'
                              ? 'text-[#17211B]/50 line-through'
                              : 'font-medium'
                          }
                        >
                          {task.title}
                        </span>
                      </div>
                      {task.status === 'done' ? (
                        <Badge variant="secondary">Completed</Badge>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCompleteTask(task.id)}
                        >
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
                Private files: only you can download them.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-0">
              {uploadMessage && (
                <div role="alert" className="text-xs font-medium text-red-600">
                  {uploadMessage}
                </div>
              )}
              {attachments.length > 0 && (
                <ul className="divide-y divide-[#17211B]/10">
                  {attachments.map((attachment) => (
                    <li
                      key={attachment.id}
                      className="flex items-center gap-3 py-2 text-sm"
                    >
                      {attachment.contentType.startsWith('image/') ? (
                        <img
                          src={api.files['project-files'].url(
                            attachment.fileId,
                            { w: 160, format: 'webp' },
                          )}
                          alt=""
                          className="h-10 w-10 rounded-[8px] object-cover"
                        />
                      ) : (
                        <span className="flex h-10 w-10 items-center justify-center rounded-[8px] bg-[#DCEBDD] text-[10px] font-semibold uppercase">
                          {attachment.filename.split('.').pop()?.slice(0, 4)}
                        </span>
                      )}
                      <a
                        href={api.files['project-files'].url(attachment.fileId)}
                        className="flex-1 truncate font-medium hover:underline"
                      >
                        {attachment.filename}
                      </a>
                      <span className="text-xs text-[#17211B]/50">
                        {formatSize(attachment.size)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void handleRemoveAttachment(attachment.id)
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                onSubmit={handleUploadFile}
                className="flex items-center space-x-3"
              >
                <input
                  type="file"
                  onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                  className="flex-1 text-xs text-[#17211B] file:mr-4 file:rounded-[10px] file:border-0 file:bg-[#DCEBDD] file:px-4 file:py-2 file:text-xs file:font-semibold file:text-[#17211B]"
                  disabled={isUploading}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={isUploading || !uploadFile}
                >
                  {isUploading ? 'Uploading...' : 'Upload Attachment'}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Delivery Rail */}
        <div className="space-y-6 md:col-span-5">
          <Card className="p-6">
            <CardHeader className="p-0 pb-4">
              <CardTitle className="text-xl">Delivery Rail Status</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <DeliveryRail />
            </CardContent>
          </Card>

          <Card className="p-6">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="text-lg">Add tasks from anywhere</CardTitle>
              <CardDescription>
                Tasks arrive here by email and by webhook too.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-0 text-sm">
              <div className="space-y-1">
                <p className="font-medium">By email</p>
                {inboxAddress ? (
                  <p className="text-[#17211B]/70">
                    Send from your account's address to{' '}
                    <code className="rounded bg-[#DCEBDD]/60 px-1 break-all">
                      {inboxAddress}
                    </code>
                    . The subject becomes the task.
                  </p>
                ) : (
                  <p className="text-[#17211B]/70">
                    Appears once a domain receives mail for this app.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <p className="font-medium">By webhook</p>
                <p className="text-[#17211B]/70">
                  POST <code>{'{ projectId, title }'}</code> to{' '}
                  <code>/api/webhooks/tasks</code>, signed with{' '}
                  <code>TASKS_WEBHOOK_SECRET</code>.
                </p>
                <code className="block rounded bg-[#DCEBDD]/60 p-2 text-xs break-all">
                  {projectId}
                </code>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
