import { useEffect, useMemo, useRef, useState } from 'react'

export interface RunActivityStep {
  id: string
  sequence: number
  kind: string
  title: string
  status: string
  visibility: string
  input?: unknown
  output?: unknown
  detail?: unknown
  startedAt: Date | string
  completedAt?: Date | string | null
}

export function RunActivity({
  steps,
  hasAnswer,
  runStatus,
}: {
  steps: RunActivityStep[]
  hasAnswer: boolean
  runStatus: string
}) {
  const visibleSteps = useMemo(
    () => steps.filter((step) => step.visibility === 'visible'),
    [steps],
  )
  const [open, setOpen] = useState(!hasAnswer)
  const previouslyHadAnswer = useRef(hasAnswer)

  useEffect(() => {
    if (!previouslyHadAnswer.current && hasAnswer) setOpen(false)
    previouslyHadAnswer.current = hasAnswer
  }, [hasAnswer])

  if (visibleSteps.length === 0 && hasAnswer) return null

  const running =
    runStatus === 'queued' ||
    runStatus === 'running' ||
    runStatus === 'waiting_for_approval' ||
    runStatus === 'cancelling'

  return (
    <details
      className="run-activity"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={running ? 'activity-pulse' : 'activity-mark'} />
        <span>{activitySummary(visibleSteps.length, runStatus)}</span>
        <span className="activity-chevron" aria-hidden="true">
          ↘
        </span>
      </summary>
      <ol className="activity-ledger">
        {visibleSteps.map((step) => (
          <li key={step.id} className={`activity-step activity-step--${step.status}`}>
            <div className="activity-step-heading">
              <span className="activity-sequence">
                {String(step.sequence).padStart(2, '0')}
              </span>
              <strong>{step.title}</strong>
              <span className="activity-duration">{formatDuration(step)}</span>
            </div>
            {step.input !== undefined && (
              <ActivityData label="input" value={step.input} />
            )}
            {step.output !== undefined && (
              <ActivityData label="output" value={step.output} />
            )}
            {step.detail !== undefined && (
              <ActivityData label="detail" value={step.detail} />
            )}
          </li>
        ))}
        {visibleSteps.length === 0 && (
          <li className="activity-awaiting">Preparing the run…</li>
        )}
      </ol>
    </details>
  )
}

function ActivityData({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="activity-data">
      <span>{label}</span>
      <pre>{formatData(value)}</pre>
    </div>
  )
}

function activitySummary(stepCount: number, status: string) {
  if (status === 'queued') return 'Queued'
  if (status === 'cancelling') return 'Stopping…'
  if (status === 'running' && stepCount === 0) return 'Agent working…'
  return `${stepCount} ${stepCount === 1 ? 'step' : 'steps'}`
}

function formatData(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function formatDuration(step: RunActivityStep) {
  if (!step.completedAt) return step.status === 'running' ? 'live' : '—'
  const duration =
    new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
  if (duration < 1000) return `${Math.max(0, duration)}ms`
  return `${(duration / 1000).toFixed(1)}s`
}
