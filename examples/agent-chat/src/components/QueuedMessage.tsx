import type { QueuedMessageState } from './queued-message'

export function QueuedMessage({
  message,
  onInterrupt,
  onRemove,
}: {
  message: QueuedMessageState
  onInterrupt: () => void
  onRemove: () => void
}) {
  return (
    <article className="queued-message" aria-label="Locally queued message">
      <div className="queued-message-label">
        <span className="queued-local-dot" aria-hidden="true" />
        Queued in this tab
      </div>
      <p>{message.content}</p>
      <div className="queued-message-actions">
        <button
          type="button"
          onClick={onInterrupt}
          disabled={message.mode === 'interrupt'}
        >
          {message.mode === 'interrupt' ? 'Stopping current run…' : 'Send now'}
        </button>
        <button type="button" onClick={onRemove}>
          Remove from queue
        </button>
      </div>
    </article>
  )
}
