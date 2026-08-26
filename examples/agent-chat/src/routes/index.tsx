import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useEffect, useRef, useState } from 'react'

import { app } from '~/bunderstack'
import { LoginGate } from '~/components/LoginGate'
import { MemoryPanel } from '~/components/MemoryPanel'
import { ApprovalPanel } from '~/components/ApprovalPanel'
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
  const messageListRef = useRef<HTMLDivElement>(null)

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
    api.agentCommitments.list.queryOptions({ input: { limit: 20 } }),
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

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight
    }
  }, [messages.data?.items.length])

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!content.trim() || send.isPending) return
    send.mutate({ content: content.trim() })
  }

  const thread = threads.data?.items[0]
  const openTasks = tasks.data?.items.filter((task) => !task.done) ?? []
  const lastRun = runs.data?.items[0]

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
              {thread?.status === 'running' ? 'Agent working' : 'Agent ready'}
            </span>
          </div>

          <div className="message-list" aria-live="polite" ref={messageListRef}>
            {messages.data?.items.length ? (
              messages.data.items.map((message) => (
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
              ))
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
                  <div className="journal-row" key={call.id}>
                    <span className="journal-icon">
                      {call.status === 'done' ? '✓' : '!'}
                    </span>
                    <div>
                      <strong>{call.tool}</strong>
                      <small>{formatTime(call.createdAt)}</small>
                    </div>
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
              {commitments.data?.items.length ? (
                commitments.data.items.slice(0, 4).map((item) => (
                  <div className="commitment" key={item.id}>
                    <span>{item.status}</span>
                    <strong>{item.title}</strong>
                    <time>{formatDateTime(item.dueAt)}</time>
                  </div>
                ))
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
