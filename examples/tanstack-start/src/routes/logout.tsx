import { createFileRoute, useNavigate } from '@tanstack/react-router'
import * as React from 'react'

import { authClient } from '~/utils/auth-client'

export const Route = createFileRoute('/logout')({
  component: LogoutPage,
})

function LogoutPage() {
  const navigate = useNavigate()

  React.useEffect(() => {
    authClient.signOut().then(() => navigate({ to: '/', replace: true }))
  }, [])

  return <div className="p-4 text-gray-500">Signing out…</div>
}
