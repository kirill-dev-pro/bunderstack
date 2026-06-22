import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { authClient } from '~/utils/auth-client'
import { useMutation } from '~/hooks/useMutation'
import { Auth } from '~/components/Auth'

export const Route = createFileRoute('/signup')({
  component: SignupComp,
})

function SignupComp() {
  const navigate = useNavigate()

  const signupMutation = useMutation({
    fn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.email.split('@')[0],
      })
      if (error) return { error: true, message: error.message ?? 'Signup failed' }
      return { error: false, message: '' }
    },
    onSuccess: async (ctx) => {
      if (!ctx.data?.error) navigate({ to: '/' })
    },
  })

  return (
    <Auth
      actionText="Sign Up"
      status={signupMutation.status}
      onSubmit={(e) => {
        const formData = new FormData(e.target as HTMLFormElement)
        signupMutation.mutate({
          email: formData.get('email') as string,
          password: formData.get('password') as string,
        })
      }}
      afterSubmit={
        signupMutation.data?.error ? (
          <div className="text-red-400">{signupMutation.data.message}</div>
        ) : null
      }
    />
  )
}
