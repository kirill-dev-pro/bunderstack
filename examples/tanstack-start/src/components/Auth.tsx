export function Auth({
  actionText,
  onSubmit,
  status,
  afterSubmit,
}: {
  actionText: string
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  status: 'pending' | 'idle' | 'success' | 'error'
  afterSubmit?: React.ReactNode
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
            <input type="email" name="email" id="email" required autoComplete="email" />
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
          <button type="submit" disabled={status === 'pending'}>
            {status === 'pending' ? 'Please wait…' : actionText}
          </button>
          {afterSubmit ?? null}
        </form>
      </article>
    </div>
  )
}
