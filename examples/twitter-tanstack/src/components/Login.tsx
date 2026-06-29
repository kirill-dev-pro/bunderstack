import { useMutation } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'

import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

import { Auth } from './Auth'

function mutationStatus(
  isPending: boolean,
  isError: boolean,
  isSuccess: boolean,
) {
  if (isPending) return 'pending' as const
  if (isError) return 'error' as const
  if (isSuccess) return 'success' as const
  return 'idle' as const
}

export function Login() {
  const router = useRouter()

  const loginMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signIn.email(data)
      if (error)
        return { error: true, message: error.message ?? 'Login failed' }
      return { error: false, message: '' }
    },
    onSuccess: async (data) => {
      if (data.error) {
        toast.error(data.message)
        return
      }
      toast.success('Welcome back!')
      await router.invalidate()
      router.navigate({ to: '/', search: { tab: 'for-you' } })
    },
    onError: (err) => {
      toast.error(err.message)
    },
  })

  const signupMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        ...data,
        name: data.email.split('@')[0],
      })
      if (error)
        return { error: true, message: error.message ?? 'Signup failed' }
      return { error: false, message: '' }
    },
    onSuccess: async (data) => {
      if (data.error) {
        toast.error(data.message)
        return
      }
      toast.success('Account created!')
      await router.invalidate()
      router.navigate({ to: '/', search: { tab: 'for-you' } })
    },
    onError: (err) => {
      toast.error(err.message)
    },
  })

  return (
    <Auth
      actionText="Log in"
      status={mutationStatus(
        loginMutation.isPending,
        loginMutation.isError,
        loginMutation.isSuccess,
      )}
      onSubmit={(e) => {
        const formData = new FormData(e.target as HTMLFormElement)
        loginMutation.mutate({
          email: formData.get('email') as string,
          password: formData.get('password') as string,
        })
      }}
      afterSubmit={
        <button
          type="button"
          className="outline"
          onClick={(e) => {
            const form = (e.target as HTMLButtonElement).closest('form')!
            const formData = new FormData(form)
            signupMutation.mutate({
              email: formData.get('email') as string,
              password: formData.get('password') as string,
            })
          }}
        >
          No account? Sign up with these credentials
        </button>
      }
    />
  )
}
