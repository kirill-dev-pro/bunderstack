import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { Auth } from '~/components/Auth'
import { toast } from '~/lib/toast'
import { authClient } from '~/utils/auth-client'

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
  const { queryClient } = Route.useRouteContext()
  const [message, setMessage] = useState<string | null>(null)

  const loginMutation = useMutation(
    {
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
    },
    queryClient,
  )

  const signupMutation = useMutation(
    {
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
    },
    queryClient,
  )

  const isPending = loginMutation.isPending || signupMutation.isPending

  return (
    <Auth
      actionText="Log in"
      status={isPending ? 'pending' : 'idle'}
      message={message}
      secondaryLabel="No account? Sign up with these credentials"
      onSubmit={(e) => {
        const form = e.currentTarget
        if (!form.reportValidity()) return
        loginMutation.mutate(readCredentials(form))
      }}
      onSecondaryClick={(e) => {
        const form = e.currentTarget.closest('form')
        if (!form || !form.reportValidity()) return
        signupMutation.mutate(readCredentials(form))
      }}
    />
  )
}
