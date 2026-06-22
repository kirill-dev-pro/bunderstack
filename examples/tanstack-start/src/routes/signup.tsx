import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

import { Auth } from '~/components/Auth'
import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

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

export const Route = createFileRoute('/signup')({
  component: SignupComp,
})

function SignupComp() {
  const navigate = useNavigate()

  const signupMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.email.split('@')[0],
      })
      if (error)
        return { error: true, message: error.message ?? 'Signup failed' }
      return { error: false, message: '' }
    },
    onSuccess: (data) => {
      if (data.error) {
        toast.error(data.message)
        return
      }
      toast.success('Account created!')
      navigate({ to: '/' })
    },
    onError: (err) => toast.error(err.message),
  })

  return (
    <Auth
      actionText="Sign up"
      status={mutationStatus(
        signupMutation.isPending,
        signupMutation.isError,
        signupMutation.isSuccess,
      )}
      onSubmit={(e) => {
        const formData = new FormData(e.target as HTMLFormElement)
        signupMutation.mutate({
          email: formData.get('email') as string,
          password: formData.get('password') as string,
        })
      }}
    />
  )
}
