import { useState } from 'react'

export interface MemoryPanelRow {
  id: string
  kind: 'preference' | 'fact' | 'summary'
  key: string
  value: unknown
  sourceType: 'user' | 'system' | 'derived'
}

export function MemoryPanel({
  rows,
  pending,
  error,
  onUpdate,
  onDelete,
}: {
  rows: MemoryPanelRow[]
  pending: boolean
  error?: string | null
  onUpdate(id: string, value: string): void | Promise<void>
  onDelete(id: string): void | Promise<void>
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  return (
    <section className="control-block" aria-labelledby="memory-title">
      <div className="control-heading">
        <div>
          <span className="control-mark">M</span>
          <h3 id="memory-title">Memory</h3>
        </div>
        <span>{rows.length} stored</span>
      </div>
      {rows.length ? (
        <div className="memory-list">
          {rows.map((row) => {
            const displayValue = formatMemoryValue(row.value)
            const editing = editingId === row.id
            return (
              <article className="memory-row" key={row.id}>
                <div className="memory-meta">
                  <span>{row.kind}</span>
                  <span>From {row.sourceType}</span>
                </div>
                <strong>{row.key}</strong>
                {editing ? (
                  <form
                    className="inline-editor"
                    onSubmit={async (event) => {
                      event.preventDefault()
                      await onUpdate(row.id, draft)
                      setEditingId(null)
                    }}
                  >
                    <textarea
                      aria-label={`Value for ${row.key}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={2}
                    />
                    <div className="action-row">
                      <button disabled={pending || !draft.trim()} type="submit">
                        Save changes
                      </button>
                      <button
                        className="button-quiet"
                        type="button"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <p>{displayValue}</p>
                    <div className="action-row">
                      <button
                        aria-label={`Edit ${row.key}`}
                        disabled={pending}
                        type="button"
                        onClick={() => {
                          setDraft(displayValue)
                          setEditingId(row.id)
                        }}
                      >
                        Edit
                      </button>
                      <button
                        aria-label={`Delete ${row.key}`}
                        className="button-danger"
                        disabled={pending}
                        type="button"
                        onClick={() => void onDelete(row.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </article>
            )
          })}
        </div>
      ) : (
        <p className="control-empty">
          Ask the agent to remember a preference. It will appear here.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function formatMemoryValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
