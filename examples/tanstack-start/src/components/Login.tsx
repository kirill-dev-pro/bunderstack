import { useRouter } from '@tanstack/react-router'
import { authClient } from '~/utils/auth-client'
import { useMutation } from '~/hooks/useMutation'
import { Auth } from './Auth'

export function Login() {
  const router = useRouter()

  const loginMutation = useMutation({
    fn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signIn.email(data)
      if (error) return { error: true, message: error.message ?? 'Login failed' }
      return { error: false, message: '' }
    },
    onSuccess: async (ctx) => {
      if (!ctx.data?.error) {
        await router.invalidate()
        router.navigate({ to: '/' })
      }
    },
  })

  const signupMutation = useMutation({
    fn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({ ...data, name: data.email.split('@')[0] })
      if (error) return { error: true, message: error.message ?? 'Signup failed' }
      return { error: false, message: '' }
    },
    onSuccess: async (ctx) => {
      if (!ctx.data?.error) {
        await router.invalidate()
        router.navigate({ to: '/' })
      }
    },
  })

  return (
    <Auth
      actionText="Login"
      status={loginMutation.status}
      onSubmit={(e) => {
        const formData = new FormData(e.target as HTMLFormElement)
        loginMutation.mutate({
          email: formData.get('email') as string,
          password: formData.get('password') as string,
        })
      }}
      afterSubmit={
        loginMutation.data?.error ? (
          <div className="space-y-2">
            <div className="text-red-400">{loginMutation.data.message}</div>
            <button
              className="text-blue-500 text-sm"
              type="button"
              onClick={(e) => {
                const form = (e.target as HTMLButtonElement).closest('form')!
                const formData = new FormData(form)
                signupMutation.mutate({
                  email: formData.get('email') as string,
                  password: formData.get('password') as string,
                })
              }}
            >
              No account? Sign up instead →
            </button>
          </div>
        ) : null
      }
    />
  )
}
