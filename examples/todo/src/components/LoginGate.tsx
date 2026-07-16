import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '~/utils/auth-client'

/** Username-only auth: anonymous session + display name. No passwords.
 *  Shared by the home page and board pages (visitors joining via link). */
export function LoginGate({ title, hint }: { title: string; hint?: string }) {
  const router = useRouter()
  const [name, setName] = useState('')

  const login = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    await authClient.signIn.anonymous()
    await authClient.updateUser({ name: name.trim() })
    await router.invalidate()
  }

  return (
    <div className="page page--center">
      <h1>{title}</h1>
      {hint && <p className="muted">{hint}</p>}
      <form onSubmit={login} className="new-todo">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pick a username"
        />
        <button type="submit">Start</button>
      </form>
    </div>
  )
}
