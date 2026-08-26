import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import { app } from '~/bunderstack'
import { ApprovalPanel } from '~/components/ApprovalPanel'
import { LoginGate } from '~/components/LoginGate'
import { MemoryPanel } from '~/components/MemoryPanel'
import { SaveAgentPanel } from '~/components/SaveAgentPanel'

const getAppName = createServerFn({ method: 'GET' }).handler(
  () => app.env.PUBLIC_APP_NAME,
)

export const Route = createFileRoute('/')({
  loader: async () => ({ appName: await getAppName() }),
  component: HomePage,
})

function HomePage() {
  const { user } = Route.useRouteContext()
  const { appName } = Route.useLoaderData()
  if (!user) return <LoginGate />
  return (
    <AgentDesk
      appName={appName}
      userName={user.name}
      isAnonymous={user.isAnonymous}
    />
  )
}

function AgentDesk({
  appName,
  userName,
  isAnonymous,
}: {
  appName: string
  userName: string
  isAnonymous: boolean
}) {
  const { api } = Route.useRouteContext()
  const router = useRouter()
  const queryClient = useQueryClient()
  const [content, setContent] = useState('')
  const [hoveredCallId, setHoveredCallId] = useState<string | null>(null)
  const [hoveredCommitmentId, setHoveredCommitmentId] = useState<string | null>(
    null,
  )
  const messageListRef = useRef<HTMLDivElement>(null)
  const now = useNow(1000)

  const threads = useQuery(
    api.agentThreads.list.queryOptions({ input: { limit: 1 } }),
  )
  const messages = useQuery(
    api.agentMessages.list.queryOptions({ input: { limit: 200 } }),
  )
  const tasks = useQuery(api.tasks.list.queryOptions({ input: { limit: 100 } }))
  const runs = useQuery(
    api.agentRuns.list.queryOptions({ input: { limit: 12 } }),
  )
  const calls = useQuery(
    api.agentToolCalls.list.queryOptions({ input: { limit: 20 } }),
  )
  const commitments = useQuery(
    api.agentCommitments.list.queryOptions({ input: { limit: 100 } }),
  )
  const memory = useQuery(
    api.agentMemory.list.queryOptions({ input: { limit: 50 } }),
  )
  const requests = useQuery(
    api.agentRequests.list.queryOptions({
      input: { limit: 20, filters: { status: 'pending' } },
    }),
  )
  const grants = useQuery(
    api.agentToolGrants.list.queryOptions({
      input: { limit: 20, filters: { status: 'active' } },
    }),
  )

  const send = useMutation(
    api.sendMessage.mutationOptions({
      onSuccess: () => {
        setContent('')
        void queryClient.invalidateQueries()
      },
    }),
  )
  const updateMemory = useMutation(
    api.updateMemory.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries(),
    }),
  )
  const deleteMemory = useMutation(
    api.deleteMemory.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries(),
    }),
  )
  const resolveApproval = useMutation(
    api.resolveApproval.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries(),
    }),
  )
  const revokeGrant = useMutation(
    api.revokeGrant.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries(),
    }),
  )

  const thread = threads.data?.items[0]
  const openTasks = tasks.data?.items.filter((task) => !task.done) ?? []
  const lastRun = runs.data?.items[0]
  const isWorking =
    thread?.status === 'running' ||
    lastRun?.status === 'running' ||
    send.isPending

  const activeCommitments = (commitments.data?.items ?? [])
    .filter(
      (item) =>
        item.status === 'pending' ||
        item.status === 'running' ||
        item.status === 'waiting_for_approval' ||
        item.status === 'paused' ||
        item.status === 'blocked',
    )
    .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())

  const finishedCommitments = (commitments.data?.items ?? [])
    .filter(
      (item) =>
        item.status !== 'pending' &&
        item.status !== 'running' &&
        item.status !== 'waiting_for_approval' &&
        item.status !== 'paused' &&
        item.status !== 'blocked',
    )
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )

  // Always show all active/scheduled commitments; fill remaining slots up to 6 with recent finished items
  const displayedCommitments =
    activeCommitments.length >= 6
      ? activeCommitments
      : [
          ...activeCommitments,
          ...finishedCommitments.slice(0, 6 - activeCommitments.length),
        ]

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight
    }
  }, [messages.data?.items.length, requests.data?.items.length, isWorking])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!content.trim() || send.isPending) return
    send.mutate({ content: content.trim() })
  }

  return (
    <main className="desk-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">BUNDERSTACK / AGENT EXPERIMENT 01</p>
          <h1>{appName}</h1>
        </div>
        <div className="identity">
          <span className="presence-dot" aria-hidden="true" />
          <span>{userName}</span>
        </div>
      </header>

      <div className="desk-grid">
        <section className="panel conversation-panel" aria-label="Conversation">
          <div className="panel-heading">
            <div>
              <span className="section-index">01</span>
              <h2>Conversation</h2>
            </div>
            <span
              className={`status-pill status-pill--${thread?.status ?? 'idle'}`}
            >
              {isWorking ? 'Agent working' : 'Agent ready'}
            </span>
          </div>

          <div className="message-list" aria-live="polite" ref={messageListRef}>
            {messages.data?.items.length ||
            requests.data?.items.length ||
            isWorking ? (
              <>
                {messages.data?.items.map((message) => (
                  <article
                    key={message.id}
                    className={`message message--${message.role}`}
                  >
                    <div className="message-meta">
                      <span>
                        {message.role === 'user' ? userName : message.role}
                      </span>
                      <time>{formatTime(message.createdAt)}</time>
                    </div>
                    <p>{message.content}</p>
                  </article>
                ))}

                {requests.data?.items.map((request) => (
                  <article
                    key={request.id}
                    className="message message--approval"
                    aria-label="Action requires approval"
                  >
                    <div className="message-meta">
                      <span className="approval-badge">Approval required</span>
                      <time>{formatTime(request.createdAt)}</time>
                    </div>
                    <div className="chat-approval-content">
                      <p className="chat-approval-prompt">{request.prompt}</p>
                      <div className="chat-approval-details">
                        <strong>
                          {request.tool ?? 'Action'}
                          {request.toolVersion
                            ? ` (v${request.toolVersion})`
                            : ''}
                        </strong>
                        {request.args && (
                          <pre>{JSON.stringify(request.args, null, 2)}</pre>
                        )}
                      </div>
                      <div className="action-row action-row--wrap">
                        <button
                          type="button"
                          disabled={resolveApproval.isPending}
                          onClick={() =>
                            resolveApproval
                              .mutateAsync({
                                id: request.id,
                                decision: 'allow_once',
                              })
                              .then(() => undefined)
                          }
                        >
                          Allow now
                        </button>
                        <button
                          type="button"
                          disabled={resolveApproval.isPending}
                          onClick={() =>
                            resolveApproval
                              .mutateAsync({
                                id: request.id,
                                decision: 'always_allow',
                              })
                              .then(() => undefined)
                          }
                        >
                          Always allow
                        </button>
                        <button
                          type="button"
                          className="button-danger"
                          disabled={resolveApproval.isPending}
                          onClick={() =>
                            resolveApproval
                              .mutateAsync({
                                id: request.id,
                                decision: 'reject',
                              })
                              .then(() => undefined)
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </article>
                ))}

                {isWorking && (
                  <article
                    className="message message--assistant message--typing"
                    aria-label="Agent is typing"
                  >
                    <div className="message-meta">
                      <span>Agent</span>
                      <span>Thinking…</span>
                    </div>
                    <div className="typing-bubble">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  </article>
                )}
              </>
            ) : (
              <div className="empty-state">
                <span className="empty-mark">↳</span>
                <h3>Start with an action.</h3>
                <p>
                  Try “Add book flights” or “Remind me in 5 minutes to stretch”.
                </p>
              </div>
            )}
          </div>

          <form className="composer" onSubmit={submit}>
            <label htmlFor="message">Message the agent</label>
            <div className="composer-row">
              <textarea
                id="message"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit(event)
                  }
                }}
                placeholder="Add a task, list tasks, complete one, or schedule a reminder…"
                rows={2}
              />
              <button
                type="submit"
                disabled={!content.trim() || send.isPending}
              >
                {send.isPending ? 'Queued' : 'Send ↗'}
              </button>
            </div>
            {send.isError && (
              <p className="form-error">
                Could not queue the message. Try again.
              </p>
            )}
          </form>
        </section>

        <aside className="panel runtime-panel" aria-label="Agent runtime">
          <div className="panel-heading">
            <div>
              <span className="section-index">02</span>
              <h2>Runtime</h2>
            </div>
            <span className="wake-counter">wake {thread?.wakeSeq ?? 0}</span>
          </div>

          <div className="runtime-block">
            <p className="runtime-label">Latest run</p>
            <div className="run-card">
              <span
                className={`run-state run-state--${lastRun?.status ?? 'idle'}`}
              >
                {lastRun?.status ?? 'idle'}
              </span>
              <strong>{lastRun?.reason ?? 'Waiting for first message'}</strong>
              {lastRun && <time>{formatTime(lastRun.startedAt)}</time>}
            </div>
          </div>

          <div className="runtime-block">
            <p className="runtime-label">Tool journal</p>
            <div className="journal-list">
              {calls.data?.items.length ? (
                calls.data.items.slice(0, 6).map((call) => (
                  <div
                    className="journal-row"
                    key={call.id}
                    onMouseEnter={() => setHoveredCallId(call.id)}
                    onMouseLeave={() => setHoveredCallId(null)}
                  >
                    <span className="journal-icon">
                      {call.status === 'done' ? '✓' : '!'}
                    </span>
                    <div>
                      <strong>{call.tool}</strong>
                      <small>{formatTime(call.createdAt)}</small>
                    </div>
                    {hoveredCallId === call.id && (
                      <ToolCallPopover call={call} />
                    )}
                  </div>
                ))
              ) : (
                <p className="quiet">No tool calls yet.</p>
              )}
            </div>
          </div>

          <div className="runtime-block">
            <p className="runtime-label">Commitments</p>
            <div className="commitment-list">
              {displayedCommitments.length ? (
                displayedCommitments.map((item) => {
                  const scheduleLabel = formatSchedule(item.schedule)
                  return (
                    <div
                      className="commitment"
                      key={item.id}
                      onMouseEnter={() => setHoveredCommitmentId(item.id)}
                      onMouseLeave={() => setHoveredCommitmentId(null)}
                    >
                      <span
                        className={`commitment-status commitment-status--${item.status}`}
                      >
                        {item.status}
                      </span>
                      <div>
                        <strong>{item.title}</strong>
                        {scheduleLabel && (
                          <span
                            className="commitment-schedule-badge"
                            style={{ marginLeft: 6 }}
                          >
                            🔄 {scheduleLabel}
                          </span>
                        )}
                      </div>
                      {(item.status === 'pending' ||
                        item.status === 'running') && (
                        <span className="commitment-countdown">
                          {item.schedule ? 'next: ' : ''}
                          {formatCountdown(item.dueAt, now)}
                        </span>
                      )}
                      <time className="commitment-time">
                        {formatDateTime(item.dueAt)}
                      </time>
                      {hoveredCommitmentId === item.id && (
                        <CommitmentPopover item={item} now={now} />
                      )}
                    </div>
                  )
                })
              ) : (
                <p className="quiet">Nothing scheduled.</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      <section className="panel task-panel" aria-label="Tasks">
        <div className="panel-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Agent-managed tasks</h2>
          </div>
          <span className="task-count">
            {openTasks.length} open / {tasks.data?.items.length ?? 0} total
          </span>
        </div>
        <div className="task-grid">
          {tasks.data?.items.length ? (
            tasks.data.items.map((task) => (
              <div
                className={`task-card ${task.done ? 'task-card--done' : ''}`}
                key={task.id}
              >
                <span className="task-check" aria-hidden="true">
                  {task.done ? '✓' : ''}
                </span>
                <div>
                  <strong>{task.title}</strong>
                  <small>{task.done ? 'Completed by agent' : 'Open'}</small>
                </div>
              </div>
            ))
          ) : (
            <p className="quiet">
              Tasks created through the agent appear here.
            </p>
          )}
        </div>
      </section>

      <section className="panel control-panel" aria-label="Agent controls">
        <div className="panel-heading">
          <div>
            <span className="section-index">04</span>
            <h2>User-held controls</h2>
          </div>
          <span className="task-count">memory · authority · account</span>
        </div>
        <div className="control-grid">
          <MemoryPanel
            rows={memory.data?.items ?? []}
            pending={updateMemory.isPending || deleteMemory.isPending}
            error={
              updateMemory.isError || deleteMemory.isError
                ? 'Memory was not changed. Try again.'
                : null
            }
            onUpdate={(id, value) =>
              updateMemory.mutateAsync({ id, value }).then(() => undefined)
            }
            onDelete={(id) =>
              deleteMemory.mutateAsync({ id }).then(() => undefined)
            }
          />
          <ApprovalPanel
            requests={requests.data?.items ?? []}
            grants={grants.data?.items ?? []}
            pending={resolveApproval.isPending || revokeGrant.isPending}
            error={
              resolveApproval.isError || revokeGrant.isError
                ? 'The permission was not changed. Try again.'
                : null
            }
            onResolve={(id, decision) =>
              resolveApproval
                .mutateAsync({ id, decision })
                .then(() => undefined)
            }
            onRevoke={(id) =>
              revokeGrant.mutateAsync({ id }).then(() => undefined)
            }
          />
          {isAnonymous && (
            <SaveAgentPanel
              userName={userName}
              onSaved={async () => {
                await router.invalidate()
                await queryClient.invalidateQueries()
              }}
            />
          )}
        </div>
      </section>
    </main>
  )
}

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(date: Date) {
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function formatCountdown(dueAt: Date | string | number, now: number) {
  const target = new Date(dueAt).getTime()
  const diffMs = target - now

  if (diffMs <= 0) {
    return 'due now'
  }

  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return `in ${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `in ${min}m ${remSec}s` : `in ${min}m`
  const hours = Math.floor(min / 60)
  const remMin = min % 60
  if (hours < 24) return remMin > 0 ? `in ${hours}h ${remMin}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`
}

function formatSchedule(schedule: unknown): string | null {
  if (!schedule || typeof schedule !== 'object') return null
  const s = schedule as { kind?: string; expr?: string; everySeconds?: number }
  if (s.kind === 'cron' && s.expr) {
    return `cron: ${s.expr}`
  }
  if (s.kind === 'interval' && s.everySeconds) {
    if (s.everySeconds >= 86400 && s.everySeconds % 86400 === 0) {
      return `every ${s.everySeconds / 86400}d`
    }
    if (s.everySeconds >= 3600 && s.everySeconds % 3600 === 0) {
      return `every ${s.everySeconds / 3600}h`
    }
    if (s.everySeconds >= 60 && s.everySeconds % 60 === 0) {
      return `every ${s.everySeconds / 60}m`
    }
    return `every ${s.everySeconds}s`
  }
  return null
}

function ToolCallPopover({
  call,
}: {
  call: {
    id: string
    tool: string
    args: Record<string, unknown>
    result?: unknown
    status: string
    error?: string | null
    createdAt: Date | string | number
  }
}) {
  return (
    <div className="detail-popover" role="tooltip">
      <div className="detail-popover-header">
        <strong className="detail-popover-title">{call.tool}</strong>
        <span
          className={`detail-popover-status detail-popover-status--${call.status}`}
        >
          {call.status}
        </span>
      </div>
      <div className="detail-popover-meta">
        <div>ID: {call.id}</div>
        <div>Time: {formatDateTime(new Date(call.createdAt))}</div>
      </div>
      <div className="detail-popover-section">
        <div className="detail-popover-section-label">Input Arguments</div>
        <pre>{JSON.stringify(call.args, null, 2)}</pre>
      </div>
      {call.result !== undefined && call.result !== null && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label">Result</div>
          <pre>{JSON.stringify(call.result, null, 2)}</pre>
        </div>
      )}
      {call.error && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label detail-popover-section-label--error">
            Error
          </div>
          <pre className="detail-popover-error">{call.error}</pre>
        </div>
      )}
    </div>
  )
}

function CommitmentPopover({
  item,
  now,
}: {
  item: {
    id: string
    title: string
    status: string
    dueAt: Date | string | number
    schedule?: unknown
    executionSpec?: unknown
    result?: unknown
    error?: string | null
    createdAt?: Date | string | number
    completedAt?: Date | string | number | null
  }
  now: number
}) {
  const scheduleLabel = formatSchedule(item.schedule)
  const spec = item.executionSpec as
    | {
        kind?: string
        message?: string
        tool?: string
        args?: Record<string, unknown>
        prompt?: string
      }
    | undefined
  const sched = item.schedule as
    | { kind?: string; expr?: string; timezone?: string }
    | undefined

  return (
    <div className="detail-popover" role="tooltip">
      <div className="detail-popover-header">
        <strong className="detail-popover-title">{item.title}</strong>
        <span className={`commitment-status commitment-status--${item.status}`}>
          {item.status}
        </span>
      </div>
      <div className="detail-popover-meta">
        <div>ID: {item.id}</div>
        <div>
          Due: {formatDateTime(new Date(item.dueAt))} (
          {formatCountdown(item.dueAt, now)})
        </div>
        {item.createdAt && (
          <div>Created: {formatDateTime(new Date(item.createdAt))}</div>
        )}
        {item.completedAt && (
          <div>Completed: {formatDateTime(new Date(item.completedAt))}</div>
        )}
      </div>

      {scheduleLabel && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label">Recurring Schedule</div>
          <div className="detail-popover-text">
            🔄 {scheduleLabel}
            {sched?.timezone ? ` (${sched.timezone})` : ''}
          </div>
        </div>
      )}

      {spec && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label">
            Execution: {spec.kind}
          </div>
          {spec.kind === 'notify' && spec.message && (
            <div className="detail-popover-text">{spec.message}</div>
          )}
          {spec.kind === 'tool_call' && (
            <div>
              <div className="detail-popover-tool-name">
                Tool: <code>{spec.tool}</code>
              </div>
              {spec.args && <pre>{JSON.stringify(spec.args, null, 2)}</pre>}
            </div>
          )}
          {spec.kind === 'objective' && spec.prompt && (
            <div className="detail-popover-text">Prompt: {spec.prompt}</div>
          )}
        </div>
      )}

      {item.result !== undefined && item.result !== null && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label">Result</div>
          <pre>{JSON.stringify(item.result, null, 2)}</pre>
        </div>
      )}

      {item.error && (
        <div className="detail-popover-section">
          <div className="detail-popover-section-label detail-popover-section-label--error">
            Error
          </div>
          <pre className="detail-popover-error">{item.error}</pre>
        </div>
      )}
    </div>
  )
}
