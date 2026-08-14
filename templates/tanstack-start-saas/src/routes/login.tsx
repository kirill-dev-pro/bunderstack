import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { EyeIcon, EyeOffIcon, Lock, Mail } from 'lucide-react'
import * as React from 'react'
import * as v from 'valibot'

import { Button } from '~/components/ui/button'
import { Card } from '~/components/ui/card'
import { Checkbox } from '~/components/ui/checkbox'
import { Input } from '~/components/ui/input'
import { signIn } from '~/lib/auth-client'

export const Route = createFileRoute('/login')({
  validateSearch: v.object({
    redirect: v.optional(v.string()),
  }),
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [isPending, setIsPending] = React.useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsPending(true)

    try {
      const res = await signIn.email({
        email,
        password,
        callbackURL: search.redirect || '/app',
      })

      if (res.error) {
        setError(res.error.message ?? 'Failed to sign in')
        setIsPending(false)
      } else {
        const target = search.redirect || '/app'
        await navigate({ href: target })
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'An unexpected error occurred',
      )
      setIsPending(false)
    }
  }

  return (
    <section className="relative isolate flex min-h-screen w-full items-center justify-center bg-[#F6F3E9] p-4">
      <div className="relative z-10 container mx-auto flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="relative w-full max-w-md p-8 shadow-xl bg-[#FFFDF7] border-[#17211B]/10 rounded-[10px]">
          <div className="mb-6 flex flex-col items-center">
            <div className="my-2 flex justify-center">
              <div className="bg-[#DCEBDD] relative size-14 rounded-full border border-[#17211B]/10 flex items-center justify-center text-[#17211B]">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 32 32"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M26 24.75C26.4142 24.75 26.75 24.4142 26.75 24C26.75 23.5858 26.4142 23.25 26 23.25V24.75ZM26 23.25H11V24.75H26V23.25ZM8.75 21V15H7.25V21H8.75ZM11 23.25C9.75736 23.25 8.75 22.2426 8.75 21H7.25C7.25 23.0711 8.92893 24.75 11 24.75V23.25Z"
                    fill="currentColor"
                  />
                  <path
                    d="M1.5 3.25C1.08579 3.25 0.75 3.58579 0.75 4C0.75 4.41421 1.08579 4.75 1.5 4.75V3.25ZM1.5 4.75H6V3.25H1.5V4.75ZM7.25 6V21H8.75V6H7.25ZM6 4.75C6.69036 4.75 7.25 5.30964 7.25 6H8.75C8.75 4.48122 7.51878 3.25 6 3.25V4.75Z"
                    fill="currentColor"
                  />
                  <path
                    d="M22 21.75C22.4142 21.75 22.75 21.4142 22.75 21C22.75 20.5858 22.4142 20.25 22 20.25V21.75ZM22 20.25H11V21.75H22V20.25ZM8.75 18V12H7.25V18H8.75ZM11 20.25C9.75736 20.25 8.75 19.2426 8.75 18H7.25C7.25 20.0711 8.92893 21.75 11 21.75V20.25Z"
                    fill="currentColor"
                  />
                  <path
                    d="M27.2057 19.754C27.0654 20.1438 26.6357 20.346 26.246 20.2057C25.8562 20.0654 25.654 19.6357 25.7943 19.246L27.2057 19.754ZM30.0361 9.67744L29.3305 9.4234L29.3305 9.4234L30.0361 9.67744ZM25.7943 19.246L29.3305 9.4234L30.7418 9.93148L27.2057 19.754L25.7943 19.246ZM28.1543 7.75L8 7.75V6.25L28.1543 6.25V7.75ZM29.3305 9.4234C29.6237 8.60882 29.0201 7.75 28.1543 7.75V6.25C30.059 6.25 31.3869 8.13941 30.7418 9.93148L29.3305 9.4234Z"
                    fill="currentColor"
                  />
                  <path
                    d="M13.5 21.75C13.0858 21.75 12.75 21.4142 12.75 21C12.75 20.5858 13.0858 20.25 13.5 20.25V21.75ZM26.7111 19.009L27.4174 19.2613L27.4174 19.2613L26.7111 19.009ZM13.5 20.25H23.8858V21.75H13.5V20.25ZM26.0048 18.7568L27.7937 13.7477L29.2063 14.2523L27.4174 19.2613L26.0048 18.7568ZM23.8858 20.25C24.8367 20.25 25.6849 19.6522 26.0048 18.7568L27.4174 19.2613C26.8843 20.7537 25.4706 21.75 23.8858 21.75V20.25Z"
                    fill="currentColor"
                  />
                  <path
                    d="M21.1694 10.5806L14.5651 17.1849"
                    stroke="currentColor"
                  />
                  <path
                    d="M22.1694 14.5806L18.5632 18.1868"
                    stroke="currentColor"
                  />
                  <circle cx="13.1" cy="26.1" r="1.7" stroke="currentColor" />
                  <circle cx="22.1" cy="26.1" r="1.7" stroke="currentColor" />
                </svg>
              </div>
            </div>
            <h1 className="font-display mb-1 text-center text-2xl font-bold tracking-tight text-[#17211B]">
              Welcome Back!
            </h1>
            <p className="text-[#17211B]/70 text-center text-sm">
              Sign in to continue your studio workflow
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-[10px] bg-red-50 p-3 text-xs text-red-700 border border-red-200"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="space-y-1">
              <label
                htmlFor="email"
                className="text-xs font-medium text-[#17211B]"
              >
                Email
              </label>
              <div className="relative">
                <Input
                  id="email"
                  type="email"
                  name="email"
                  placeholder="me@example.com"
                  className="ps-10 h-10 text-sm"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isPending}
                />
                <Mail className="text-[#17211B]/40 absolute start-3 top-1/2 size-4 -translate-y-1/2" />
              </div>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="password"
                className="text-xs font-medium text-[#17211B]"
              >
                Password
              </label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password"
                  className="ps-10 pe-10 h-10 text-sm"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isPending}
                />
                <Lock className="text-[#17211B]/40 absolute start-3 top-1/2 size-4 -translate-y-1/2" />
                <button
                  type="button"
                  className="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-[#17211B]/50 hover:text-[#17211B] cursor-pointer"
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {showPassword ? (
                    <EyeIcon className="size-4" />
                  ) : (
                    <EyeOffIcon className="size-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Checkbox id="remember" />
                <label
                  htmlFor="remember"
                  className="text-xs text-[#17211B]/70 cursor-pointer"
                >
                  Remember me
                </label>
              </div>
              <a href="#" className="text-xs text-[#315CF5] hover:underline">
                Forgot password?
              </a>
            </div>

            <Button
              type="submit"
              disabled={isPending}
              className="h-10 w-full font-medium"
            >
              {isPending ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <p className="mt-6 flex justify-center gap-1 text-center text-sm text-[#17211B]/70">
            <span>Don't have an account?</span>
            <Link
              to="/register"
              className="font-semibold text-[#315CF5] hover:underline"
            >
              Create an account
            </Link>
          </p>
        </Card>
      </div>
    </section>
  )
}
