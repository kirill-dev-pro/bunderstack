import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'

import { RunActivity, type RunActivityStep } from './RunActivity'
import { mergeRevisionedMessage, nextTextFrame } from './streaming-text'

export interface StreamedMessage {
  id: string
  content: string
  status: string
  revision: number
}

export interface StreamedRun {
  id: string
  status: string
  error?: string | null
}

export function StreamingMessage({
  message,
  run,
  steps,
  onStop,
}: {
  message: StreamedMessage
  run?: StreamedRun
  steps: RunActivityStep[]
  onStop: (runId: string) => void
}) {
  const [canonical, setCanonical] = useState(message)
  const [displayedContent, setDisplayedContent] = useState(message.content)

  useEffect(() => {
    setCanonical((current) => mergeRevisionedMessage(current, message))
  }, [message])

  useEffect(() => {
    if (canonical.id !== message.id) {
      setDisplayedContent(canonical.content)
      return
    }

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      setDisplayedContent(canonical.content)
      return
    }

    let frame = 0
    let current = displayedContent
    const advance = () => {
      current = nextTextFrame(current, canonical.content)
      setDisplayedContent(current)
      if (current !== canonical.content) frame = requestAnimationFrame(advance)
    }
    if (current !== canonical.content) frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [canonical])

  const html = useMemo(
    () => marked.parse(displayedContent, { breaks: true, gfm: true }) as string,
    [displayedContent],
  )
  const active =
    run &&
    (run.status === 'queued' ||
      run.status === 'running' ||
      run.status === 'waiting_for_approval' ||
      run.status === 'cancelling')

  return (
    <div
      className={`streaming-message streaming-message--${canonical.status}`}
      aria-label={active ? 'Streaming answer' : 'Assistant answer'}
    >
      {run && (
        <RunActivity
          steps={steps}
          hasAnswer={Boolean(displayedContent)}
          runStatus={run.status}
        />
      )}
      {displayedContent && (
        <div
          className="message-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {active && run && (
        <div className="streaming-actions">
          <button
            type="button"
            className="stop-generation"
            disabled={run.status === 'cancelling'}
            onClick={() => onStop(run.id)}
          >
            <span aria-hidden="true">■</span>{' '}
            {run.status === 'cancelling' ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      )}
      {canonical.status === 'cancelled' && (
        <p className="stream-terminal stream-terminal--cancelled">Stopped by user</p>
      )}
      {canonical.status === 'error' && (
        <p className="stream-terminal stream-terminal--error">
          <strong>Partial answer preserved.</strong>{' '}
          {run?.error ?? 'The run could not be completed.'}
        </p>
      )}
    </div>
  )
}
