export interface ApprovalRequestRow {
  id: string
  tool: string | null
  toolVersion: number | null
  args: Record<string, unknown> | null
  prompt: string
}

export interface ToolGrantRow {
  id: string
  tool: string
  toolVersion: number
  grantedAt: Date
  lastUsedAt: Date | null
}

export function ApprovalPanel({
  requests,
  grants,
  pending,
  error,
  onResolve,
  onRevoke,
}: {
  requests: ApprovalRequestRow[]
  grants: ToolGrantRow[]
  pending: boolean
  error?: string | null
  onResolve(
    id: string,
    decision: 'allow_once' | 'always_allow' | 'reject',
  ): void | Promise<void>
  onRevoke(id: string): void | Promise<void>
}) {
  return (
    <section
      className="control-block control-block--authority"
      aria-labelledby="approval-title"
    >
      <div className="control-heading">
        <div>
          <span className="control-mark">A</span>
          <h3 id="approval-title">Authority</h3>
        </div>
        <span>{requests.length} waiting</span>
      </div>

      {requests.map((request) => (
        <article className="approval-card" key={request.id}>
          <span className="approval-state">Needs your decision</span>
          <strong>
            {request.tool ?? 'Input'}
            {request.toolVersion ? ` / v${request.toolVersion}` : ''}
          </strong>
          <p>{request.prompt}</p>
          {request.args && <pre>{JSON.stringify(request.args, null, 2)}</pre>}
          <div className="action-row action-row--wrap">
            <button
              disabled={pending}
              type="button"
              onClick={() => void onResolve(request.id, 'allow_once')}
            >
              Allow now
            </button>
            <button
              disabled={pending}
              type="button"
              onClick={() => void onResolve(request.id, 'always_allow')}
            >
              Always allow
            </button>
            <button
              className="button-danger"
              disabled={pending}
              type="button"
              onClick={() => void onResolve(request.id, 'reject')}
            >
              Reject
            </button>
          </div>
        </article>
      ))}

      <div className="grant-list">
        <p className="control-subtitle">Standing permissions</p>
        {grants.length ? (
          grants.map((grant) => (
            <article className="grant-row" key={grant.id}>
              <div>
                <strong>{grant.tool}</strong>
                <small>
                  v{grant.toolVersion} · granted {formatDate(grant.grantedAt)}
                  {grant.lastUsedAt
                    ? ` · used ${formatDate(grant.lastUsedAt)}`
                    : ' · not used yet'}
                </small>
              </div>
              <button
                className="button-danger"
                disabled={pending}
                type="button"
                onClick={() => void onRevoke(grant.id)}
              >
                Revoke
              </button>
            </article>
          ))
        ) : (
          <p className="control-empty">No standing permissions.</p>
        )}
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}

function formatDate(date: Date) {
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
