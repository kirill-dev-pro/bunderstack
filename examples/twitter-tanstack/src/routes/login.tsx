import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function readCredentials(form: HTMLFormElement) {
  const formData = new FormData(form)
  return {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  }
}

function LoginPage() {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)

  const loginMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signIn.email(data)
      if (error) throw new Error(error.message ?? 'Login failed')
    },
    onMutate: () => setMessage(null),
    onSuccess: async () => {
      toast.success('Welcome back!')
      await router.invalidate()
      await router.navigate({ to: '/', search: { tab: 'for-you' } })
    },
    onError: (err) => {
      setMessage(err.message)
      toast.error(err.message)
    },
  })

  const signupMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        ...data,
        name: data.email.split('@')[0],
      })
      if (error) throw new Error(error.message ?? 'Signup failed')
    },
    onMutate: () => setMessage(null),
    onSuccess: async () => {
      toast.success('Account created!')
      await router.invalidate()
      await router.navigate({ to: '/', search: { tab: 'for-you' } })
    },
    onError: (err) => {
      setMessage(err.message)
      toast.error(err.message)
    },
  })

  const isPending = loginMutation.isPending || signupMutation.isPending

  return (
    <div className="auth-page">
      <article className="card">
        <header>
          <h1>Log in</h1>
        </header>
        <form
          className="vstack"
          onSubmit={(e) => {
            e.preventDefault()
            const form = e.currentTarget
            if (!form.reportValidity()) return
            loginMutation.mutate(readCredentials(form))
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
          <button type="submit" disabled={isPending}>
            {isPending ? 'Please wait…' : 'Log in'}
          </button>
          <button
            type="button"
            className="outline"
            disabled={isPending}
            onClick={(e) => {
              const form = e.currentTarget.closest('form')
              if (!form || !form.reportValidity()) return
              signupMutation.mutate(readCredentials(form))
            }}
          >
            No account? Sign up with these credentials
          </button>
        </form>
      </article>
    </div>
  )
}
