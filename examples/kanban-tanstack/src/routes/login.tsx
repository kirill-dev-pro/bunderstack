import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useRouter, useSearch } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const { redirect: redirectTo } = useSearch({ from: '/login' })
  const [mode, setMode] = useState<'in' | 'up'>('in')

  const authMutation = useMutation({
    mutationFn: async (data: {
      email: string
      password: string
      name?: string
    }) => {
      const fn =
        mode === 'in'
          ? authClient.signIn.email({
              email: data.email,
              password: data.password,
            })
          : authClient.signUp.email({
              email: data.email,
              password: data.password,
              name: data.name ?? data.email.split('@')[0] ?? 'User',
            })
      const { error } = await fn
      if (error) throw new Error(error.message ?? 'Authentication failed')
    },
    onSuccess: async () => {
      toast.success(mode === 'in' ? 'Welcome back!' : 'Account created!')
      await router.invalidate()
      if (redirectTo) {
        await router.navigate({ to: redirectTo })
      } else {
        await router.navigate({ to: '/' })
      }
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <div className="auth-page">
      <article className="card auth-card">
        <header>
          <h1>Kanban</h1>
          <p className="auth-tagline">Org-scoped boards with live updates</p>
        </header>
        <form
          className="vstack"
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            authMutation.mutate({
              email: fd.get('email') as string,
              password: fd.get('password') as string,
              name: (fd.get('name') as string) || undefined,
            })
          }}
        >
          {mode === 'up' && (
            <label>
              Name
              <input name="name" type="text" autoComplete="name" />
            </label>
          )}
          <label>
            Email
            <input
              name="email"
              type="email"
              defaultValue="alice@example.com"
              required
              autoComplete="email"
            />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              defaultValue="password123"
              required
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            />
          </label>
          <button type="submit" disabled={authMutation.isPending}>
            {authMutation.isPending
              ? 'Please wait…'
              : mode === 'in'
                ? 'Sign in'
                : 'Sign up'}
          </button>
          <button
            type="button"
            className="outline"
            onClick={() => setMode(mode === 'in' ? 'up' : 'in')}
          >
            {mode === 'in'
              ? 'Need an account? Sign up'
              : 'Have an account? Sign in'}
          </button>
        </form>
        <p className="auth-hint">
          Demo: <code>alice@example.com</code> / <code>password123</code> — run{' '}
          <code>bun run seed</code> first.
        </p>
      </article>
    </div>
  )
}
