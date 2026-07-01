export function Auth({
  actionText,
  onSubmit,
  onSecondaryClick,
  secondaryLabel,
  status,
  message,
}: {
  actionText: string
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  onSecondaryClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  secondaryLabel?: string
  status: 'pending' | 'idle' | 'success' | 'error'
  message?: string | null
}) {
  return (
    <div className="auth-page">
      <article className="card">
        <header>
          <h1>{actionText}</h1>
        </header>
        <form
          className="vstack"
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(e)
          }}
        >
          <label>
            Email
            <input
              type="email"
              name="email"
              id="email"
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              id="password"
              required
              autoComplete="current-password"
            />
          </label>
          {message ? (
            <output data-variant="danger" role="alert">
              {message}
            </output>
          ) : null}
          <button type="submit" disabled={status === 'pending'}>
            {status === 'pending' ? 'Please wait…' : actionText}
          </button>
          {onSecondaryClick && secondaryLabel ? (
            <button
              type="button"
              className="outline"
              disabled={status === 'pending'}
              onClick={onSecondaryClick}
            >
              {secondaryLabel}
            </button>
          ) : null}
        </form>
      </article>
    </div>
  )
}
