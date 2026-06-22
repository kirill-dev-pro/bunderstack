import { createFileRoute } from '@tanstack/react-router'
import { Login } from '~/components/Login'

// All child routes under /_authed require authentication.
// If not logged in, BetterAuth session is absent → we show the Login overlay.
export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw new Error('Not authenticated')
  },
  errorComponent: ({ error }) => {
    if (error.message === 'Not authenticated') return <Login />
    throw error
  },
})
