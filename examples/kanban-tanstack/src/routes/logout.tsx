import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { closeRealtime } from '~/lib/realtime'
import { authClient } from '~/utils/auth-client'

export const Route = createFileRoute('/logout')({
  component: LogoutPage,
})

function LogoutPage() {
  const navigate = useNavigate()

  useEffect(() => {
    void authClient.signOut().then(() => {
      closeRealtime()
      void navigate({ to: '/login', replace: true })
    })
  }, [navigate])

  return <p style={{ padding: '2rem', textAlign: 'center' }}>Signing out…</p>
}
