import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

import { authClient } from '~/utils/auth-client'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const loginMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signIn.email(data)
      if (error) throw new Error(error.message ?? 'Login failed')
    },
    onSuccess: async () => {
      toast.success('Login successful')
      await router.invalidate()
      await router.navigate({ to: '/' })
    },
    onError: (error) => {
      toast.error(error.message ?? 'Login failed')
    },
  })

  const registerMutation = useMutation({
    mutationFn: async (data: { email: string; password: string }) => {
      const { error } = await authClient.signUp.email({
        ...data,
        name: data.email.split('@')[0],
      })
      if (error) throw new Error(error.message ?? 'Registration failed')
    },
    onSuccess: async () => {
      toast.success('Registration successful')
      await router.invalidate()
      await router.navigate({ to: '/' })
    },
    onError: (error) => {
      toast.error(error.message ?? 'Registration failed')
    },
  })

  return (
    <div className="p-2 flex justify-center items-center h-full">
      <div className="p-2 card flex flex-col gap-2 border rounded">
        <h3>Auth form</h3>
        <div className="flex flex-col gap-2">
          <label>
            Email
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => loginMutation.mutate({ email, password })}
          >
            Login
          </button>
          <button
            type="button"
            onClick={() => registerMutation.mutate({ email, password })}
          >
            Register
          </button>
        </div>
      </div>
    </div>
  )
}
