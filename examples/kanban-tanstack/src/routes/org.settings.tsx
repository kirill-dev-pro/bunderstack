import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'

import { KanbanShell } from '~/components/KanbanShell'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'
import { authClient } from '~/utils/auth-client'
import { toast } from '~/utils/oat'

export const Route = createFileRoute('/org/settings')({
  beforeLoad: ({ context }) => {
    if (!context.user)
      throw redirect({ to: '/login', search: { redirect: undefined } })
  },
  component: OrgSettingsPage,
})

type Member = {
  id: string
  userId: string
  role: string
  user?: { name?: string; email?: string; image?: string | null }
}

type Invitation = {
  id: string
  email: string
  role?: string | null
  status: string
}

function OrgSettingsPage() {
  const { user } = Route.useRouteContext()
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')

  const { data: org, refetch } = useQuery({
    queryKey: ['full-organization'],
    queryFn: async () => {
      const res = await authClient.organization.getFullOrganization()
      return res.data
    },
  })

  const { data: myRole } = useQuery({
    queryKey: ['active-member-role'],
    queryFn: async () => {
      const res = await authClient.organization.getActiveMemberRole()
      return res.data?.role ?? 'member'
    },
  })

  const canManage = myRole === 'owner' || myRole === 'admin'
  const canChangeRoles = myRole === 'owner'

  const inviteMutation = useToastMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      if (error) throw new Error(error.message ?? 'Invite failed')
    },
    onSuccess: () => {
      setInviteEmail('')
      void refetch()
    },
    successMessage: 'Invitation sent',
  })

  const removeMutation = useToastMutation({
    mutationFn: async (memberIdOrEmail: string) => {
      const { error } = await authClient.organization.removeMember({
        memberIdOrEmail,
      })
      if (error) throw new Error(error.message ?? 'Remove failed')
    },
    onSuccess: () => void refetch(),
    successMessage: 'Member removed',
  })

  const roleMutation = useToastMutation({
    mutationFn: async ({
      memberId,
      role,
    }: {
      memberId: string
      role: string
    }) => {
      const { error } = await authClient.organization.updateMemberRole({
        memberId,
        role,
      })
      if (error) throw new Error(error.message ?? 'Role update failed')
    },
    onSuccess: () => void refetch(),
    successMessage: 'Role updated',
  })

  const cancelInviteMutation = useToastMutation({
    mutationFn: async (invitationId: string) => {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId,
      })
      if (error) throw new Error(error.message ?? 'Cancel failed')
    },
    onSuccess: () => void refetch(),
    successMessage: 'Invitation cancelled',
  })

  function copyInviteLink(invitationId: string) {
    const url = `${window.location.origin}/invite/${invitationId}`
    void navigator.clipboard.writeText(url).then(() => {
      toast.success('Invite link copied')
    })
  }

  const members = (org?.members ?? []) as Member[]
  const invitations = ((org?.invitations ?? []) as Invitation[]).filter(
    (i) => i.status === 'pending',
  )

  return (
    <KanbanShell user={user!}>
      <div className="org-settings-page">
        <header className="org-settings-header">
          <h1>Workspace settings</h1>
          <p className="org-settings-subtitle">{org?.name ?? 'Organization'}</p>
        </header>

        <section className="org-settings-section">
          <h2>Members</h2>
          <ul className="org-members-list">
            {members.map((m) => (
              <li key={m.id} className="org-member-row">
                <UserAvatar
                  name={m.user?.name ?? '?'}
                  image={m.user?.image}
                  size={36}
                />
                <div className="org-member-info">
                  <strong>{m.user?.name ?? m.userId}</strong>
                  <span>{m.user?.email}</span>
                </div>
                {canChangeRoles && m.userId !== user!.id ? (
                  <select
                    value={m.role}
                    onChange={(e) =>
                      roleMutation.mutate({
                        memberId: m.id,
                        role: e.target.value,
                      })
                    }
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                ) : (
                  <span className="role-badge">{m.role}</span>
                )}
                {canManage && m.userId !== user!.id ? (
                  <button
                    type="button"
                    className="outline"
                    onClick={() => removeMutation.mutate(m.id)}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {canManage ? (
          <section className="org-settings-section">
            <h2>Invite members</h2>
            <form
              className="org-invite-form"
              onSubmit={(e) => {
                e.preventDefault()
                if (!inviteEmail.trim()) return
                inviteMutation.mutate(undefined)
              }}
            >
              <input
                type="email"
                placeholder="Email address"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
              <select
                value={inviteRole}
                onChange={(e) =>
                  setInviteRole(e.target.value as 'member' | 'admin')
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="submit"
                disabled={inviteMutation.isPending || !inviteEmail.trim()}
              >
                Send invite
              </button>
            </form>
          </section>
        ) : null}

        {canManage && invitations.length > 0 ? (
          <section className="org-settings-section">
            <h2>Pending invitations</h2>
            <ul className="org-invites-list">
              {invitations.map((inv) => (
                <li key={inv.id} className="org-invite-row">
                  <div>
                    <strong>{inv.email}</strong>
                    <span className="role-badge">{inv.role ?? 'member'}</span>
                  </div>
                  <div className="org-invite-actions">
                    <button
                      type="button"
                      className="outline"
                      onClick={() => copyInviteLink(inv.id)}
                    >
                      Copy invite link
                    </button>
                    <button
                      type="button"
                      className="outline"
                      onClick={() => cancelInviteMutation.mutate(inv.id)}
                    >
                      Cancel
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </KanbanShell>
  )
}
