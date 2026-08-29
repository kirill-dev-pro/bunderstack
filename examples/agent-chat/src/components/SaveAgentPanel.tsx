import { useState } from 'react'

import { authClient } from '~/utils/auth-client'

export function SaveAgentPanel({
  userName,
  onSaved,
}: {
  userName: string
  onSaved(): void | Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    const result = await authClient.signUp.email({
      email: email.trim(),
      password,
      name: userName,
    })
    if (result.error) {
      setError(result.error.message ?? 'Could not save this agent account.')
      setPending(false)
      return
    }
    await onSaved()
    setPending(false)
  }

  return (
    <section className="control-block save-agent" aria-labelledby="save-agent-title">
      <div className="control-heading">
        <div>
          <span className="control-mark">S</span>
          <h3 id="save-agent-title">Save your agent</h3>
        </div>
        <span>Optional</span>
      </div>
      <p className="save-agent-copy">
        Keep this conversation, memory, and permissions on a password account.
      </p>
      <form onSubmit={save} className="save-agent-form">
        <label htmlFor="save-agent-email">Email</label>
        <input
          id="save-agent-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="save-agent-password">Password</label>
        <input
          id="save-agent-password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button disabled={pending || !email.trim() || password.length < 8} type="submit">
          {pending ? 'Saving…' : 'Save your agent'}
        </button>
        {error && <p className="form-error">{error}</p>}
      </form>
    </section>
  )
}
