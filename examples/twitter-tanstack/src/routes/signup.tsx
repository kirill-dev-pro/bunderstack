import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { Auth } from '~/components/Auth'
import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

export const Route = createFileRoute('/signup')({
  component: SignupComp,
})

function SignupComp() {
  const navigate = useNavigate()
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)

  const signupMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        email: data.email,
        password: data.password,
        name: data.email.split('@')[0],
      })
      if (error) throw new Error(error.message ?? 'Signup failed')
    },
    onMutate: () => setMessage(null),
    onSuccess: async () => {
      toast.success('Account created!')
      await router.invalidate()
      await navigate({ to: '/', search: { tab: 'for-you' } })
    },
    onError: (err) => {
      setMessage(err.message)
      toast.error(err.message)
    },
  })

  return (
    <Auth
      actionText="Sign up"
      status={signupMutation.isPending ? 'pending' : 'idle'}
      message={message}
      onSubmit={(e) => {
        const form = e.currentTarget
        if (!form.reportValidity()) return
        const formData = new FormData(form)
        signupMutation.mutate({
          email: formData.get('email') as string,
          password: formData.get('password') as string,
        })
      }}
    />
  )
}
