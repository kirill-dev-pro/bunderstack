import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import type { AppApi } from '~/api-client'

import {
  queueAction,
  type QueuedMessageState,
} from '~/components/queued-message'

const activeRunStatuses = new Set([
  'queued',
  'running',
  'waiting_for_approval',
  'cancelling',
])

interface SubmissionIdentity {
  clientMessageId: string
  content: string
}

export function useAgentChat(api: AppApi) {
  const queryClient = useQueryClient()
  const [content, setContentState] = useState('')
  const [retry, setRetry] = useState<SubmissionIdentity | null>(null)
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessageState | null>(
    null,
  )
  const [acceptedRunId, setAcceptedRunId] = useState<string | null>(null)
  const [syncingConflict, setSyncingConflict] = useState(false)

  const messages = useQuery(
    api.agentMessages.list.queryOptions({ input: { limit: 200 } }),
  )
  const runs = useQuery(
    api.agentRuns.list.queryOptions({ input: { limit: 100 } }),
  )
  const steps = useQuery(
    api.agentRunSteps.list.queryOptions({ input: { limit: 300 } }),
  )

  const canonicalActiveRun = runs.data?.items.find(
    (run) =>
      run.triggerType === 'user_message' && activeRunStatuses.has(run.status),
  )
  const acceptedRun = runs.data?.items.find((run) => run.id === acceptedRunId)
  const activeRun =
    canonicalActiveRun ??
    (acceptedRunId &&
    (!acceptedRun || activeRunStatuses.has(acceptedRun.status))
      ? {
          id: acceptedRunId,
          status: acceptedRun?.status ?? ('queued' as const),
          triggerType: 'user_message' as const,
          error: acceptedRun?.error ?? null,
        }
      : undefined)

  const runsById = useMemo(
    () => new Map((runs.data?.items ?? []).map((run) => [run.id, run])),
    [runs.data?.items],
  )
  const stepsByRunId = useMemo(() => {
    const indexed = new Map<string, NonNullable<typeof steps.data>['items']>()
    for (const step of steps.data?.items ?? []) {
      const runSteps = indexed.get(step.runId) ?? []
      runSteps.push(step)
      indexed.set(step.runId, runSteps)
    }
    return indexed
  }, [steps.data?.items])

  const send = useMutation(api.sendMessage.mutationOptions())
  const stop = useMutation(api.stopRun.mutationOptions())

  useEffect(() => {
    if (acceptedRun && !activeRunStatuses.has(acceptedRun.status)) {
      setAcceptedRunId(null)
    }
  }, [acceptedRun])

  useEffect(() => {
    if (!queuedMessage || send.isPending || syncingConflict) return
    const action = queueAction(queuedMessage, activeRun?.status)
    if (action.type === 'wait') return
    if (action.type === 'stop') {
      if (!activeRun || stop.isPending) return
      setQueuedMessage((current) =>
        current ? { ...current, mode: 'after-current' } : current,
      )
      stop.mutate({ id: activeRun.id })
      return
    }

    setQueuedMessage(null)
    accept(action.message)
  }, [
    queuedMessage,
    activeRun?.id,
    activeRun?.status,
    send.isPending,
    syncingConflict,
  ])

  function setContent(next: string) {
    setContentState(next)
    if (retry && retry.content !== next) setRetry(null)
  }

  function submit() {
    const trimmed = content.trim()
    if (!trimmed || send.isPending || queuedMessage) return
    const submission =
      retry?.content === trimmed
        ? retry
        : { content: trimmed, clientMessageId: crypto.randomUUID() }

    setContentState('')
    setRetry(null)
    if (activeRun) {
      setQueuedMessage({ ...submission, mode: 'after-current' })
      return
    }
    accept(submission)
  }

  function accept(submission: SubmissionIdentity) {
    send.mutate(submission, {
      onSuccess: (accepted) => {
        setAcceptedRunId(accepted.runId)
        void queryClient.invalidateQueries()
      },
      onError: (error) => {
        if (isConflict(error)) {
          setSyncingConflict(true)
          setQueuedMessage({ ...submission, mode: 'after-current' })
          void queryClient.invalidateQueries().finally(() => {
            setSyncingConflict(false)
          })
          return
        }
        setContentState(submission.content)
        setRetry(submission)
      },
    })
  }

  return {
    content,
    setContent,
    submit,
    messages,
    runs,
    steps,
    activeRun,
    runsById,
    stepsByRunId,
    queuedMessage,
    interruptQueuedMessage: () =>
      setQueuedMessage((current) =>
        current ? { ...current, mode: 'interrupt' } : current,
      ),
    removeQueuedMessage: () => setQueuedMessage(null),
    stopRun: (runId: string) => stop.mutate({ id: runId }),
    isSending: send.isPending,
    isStopping: stop.isPending,
    isWorking: Boolean(activeRun) || send.isPending,
    sendError: send.error && !isConflict(send.error) ? send.error : null,
  }
}

function isConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'CONFLICT'
  )
}
