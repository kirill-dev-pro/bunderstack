import { useNavigate } from '@solidjs/router'
import { createSignal, Show } from 'solid-js'

import { authClient } from '../lib/auth-client.ts'

export function Login() {
  const navigate = useNavigate()
  const [mode, setMode] = createSignal<'in' | 'up'>('in')
  const [email, setEmail] = createSignal('alice@example.com')
  const [password, setPassword] = createSignal('password123')
  const [error, setError] = createSignal('')
  const [pending, setPending] = createSignal(false)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      const result =
        mode() === 'in'
          ? await authClient.signIn.email({
              email: email(),
              password: password(),
            })
          : await authClient.signUp.email({
              email: email(),
              password: password(),
              name: email().split('@')[0] ?? 'User',
            })
      if (result.error) {
        setError(result.error.message ?? 'Authentication failed')
        return
      }
      navigate('/', { replace: true })
    } finally {
      setPending(false)
    }
  }

  return (
    <main class="ot-container" style="max-width: 24rem; margin: 4rem auto">
      <h1>Kanban</h1>
      <p>Org-scoped boards with live updates.</p>
      <form onSubmit={submit} style="display:grid; gap:.75rem">
        <input
          type="email"
          placeholder="Email"
          autocomplete="email"
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
        <input
          type="password"
          placeholder="Password"
          autocomplete="current-password"
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
        <button type="submit" disabled={pending()}>
          {mode() === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <p>
        <button
          type="button"
          onClick={() => setMode(mode() === 'in' ? 'up' : 'in')}
        >
          {mode() === 'in' ? 'Need an account?' : 'Have an account?'}
        </button>
      </p>
      <p>
        Seeded accounts use the password <code>password123</code>.
      </p>
    </main>
  )
}
