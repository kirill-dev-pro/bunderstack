import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '~/utils/auth-client'

export function LoginGate() {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function login() {
    setPending(true)
    await authClient.signIn.anonymous()
    await router.invalidate()
    setPending(false)
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">BUNDERSTACK / AGENT EXPERIMENT 01</p>
        <h1>A small agent with a long memory.</h1>
        <p className="login-copy">
          Start instantly, then create tasks, keep preferences, and schedule
          background reminders. You can save the agent to an email and password
          later.
        </p>
        <button disabled={pending} type="button" onClick={login}>
          {pending ? 'Opening…' : 'Continue anonymously →'}
        </button>
      </section>
    </main>
  )
}
