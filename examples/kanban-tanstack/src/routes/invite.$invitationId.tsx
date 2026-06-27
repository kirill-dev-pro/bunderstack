import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { useToastMutation } from '~/hooks/useToastMutation'
import { authClient } from '~/utils/auth-client'

export const Route = createFileRoute('/invite/$invitationId')({
  beforeLoad: ({ context, params, location }) => {
    if (!context.user) {
      throw redirect({
        to: '/login',
        search: { redirect: location.pathname },
      })
    }
  },
  component: InviteAcceptPage,
})

function InviteAcceptPage() {
  const router = useRouter()
  const { invitationId } = Route.useParams()
  const { user } = Route.useRouteContext()
  const [declined, setDeclined] = useState(false)

  const { data: invitation, isLoading, error } = useQuery({
    queryKey: ['invitation', invitationId],
    queryFn: async () => {
      const res = await authClient.organization.getInvitation({
        query: { id: invitationId },
      })
      if (res.error) throw new Error(res.error.message ?? 'Invitation not found')
      return res.data
    },
  })

  const acceptMutation = useToastMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      })
      if (error) throw new Error(error.message ?? 'Could not accept invitation')
    },
    onSuccess: async () => {
      if (invitation?.organizationId) {
        await authClient.organization.setActive({
          organizationId: invitation.organizationId,
        })
      }
      await router.invalidate()
      await router.navigate({ to: '/' })
    },
    successMessage: 'Welcome to the workspace!',
  })

  const rejectMutation = useToastMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      })
      if (error) throw new Error(error.message ?? 'Could not decline invitation')
    },
    onSuccess: async () => {
      setDeclined(true)
      await router.navigate({ to: '/' })
    },
    successMessage: 'Invitation declined',
  })

  if (isLoading) {
    return (
      <div className="invite-page">
        <div className="card invite-card">
          <div className="skeleton" style={{ height: '8rem' }} />
        </div>
      </div>
    )
  }

  if (error || !invitation) {
    return (
      <div className="invite-page">
        <article className="card invite-card">
          <h1>Invitation not found</h1>
          <p>This invite may have expired or already been used.</p>
        </article>
      </div>
    )
  }

  const emailMismatch =
    invitation.email &&
    user?.email &&
    invitation.email.toLowerCase() !== user.email.toLowerCase()

  return (
    <div className="invite-page">
      <article className="card invite-card">
        <h1>Workspace invitation</h1>
        <p>
          You&apos;ve been invited to join <strong>{invitation.organizationName ?? 'a workspace'}</strong> as{' '}
          <strong>{invitation.role ?? 'member'}</strong>.
        </p>
        {emailMismatch ? (
          <p className="invite-warning">
            This invitation was sent to <strong>{invitation.email}</strong>. You are
            signed in as <strong>{user?.email}</strong>.
          </p>
        ) : null}
        <div className="invite-actions">
          <button
            type="button"
            onClick={() => acceptMutation.mutate()}
            disabled={acceptMutation.isPending || declined}
          >
            Accept invitation
          </button>
          <button
            type="button"
            className="outline"
            onClick={() => rejectMutation.mutate()}
            disabled={rejectMutation.isPending || declined}
          >
            Decline
          </button>
        </div>
      </article>
    </div>
  )
}
