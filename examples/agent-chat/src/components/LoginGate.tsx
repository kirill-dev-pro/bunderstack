import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '~/utils/auth-client'

export function LoginGate() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)

  async function login(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    setPending(true)
    await authClient.signIn.anonymous()
    await authClient.updateUser({ name: name.trim() })
    await router.invalidate()
    setPending(false)
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">BUNDERSTACK / AGENT EXPERIMENT 01</p>
        <h1>A small agent with a long memory.</h1>
        <p className="login-copy">
          Give it a name, then create tasks and schedule a background reminder.
          No API key is required.
        </p>
        <form onSubmit={login} className="login-form">
          <label htmlFor="name">Your display name</label>
          <div className="input-row">
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kirill"
              autoComplete="name"
              autoFocus
            />
            <button disabled={pending || !name.trim()} type="submit">
              {pending ? 'Opening…' : 'Open desk →'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
