import * as React from 'react'

import { api } from '~/api-client'
import { useToastMutation } from '~/hooks/useToastMutation'

type FollowButtonProps = {
  currentUserId: string | null
  targetUserId: string
  follows: Array<{ id: number; followerId: string; followingId: string }>
}

export function FollowButton({
  currentUserId,
  targetUserId,
  follows,
}: FollowButtonProps) {
  const existing = React.useMemo(
    () =>
      currentUserId
        ? follows.find(
            (f) =>
              f.followerId === currentUserId && f.followingId === targetUserId,
          )
        : undefined,
    [currentUserId, follows, targetUserId],
  )

  const followMutation = useToastMutation(
    api.follows.createMutation({
      successMessage: 'Following',
      errorMessage: 'Could not follow',
    }),
  )

  const unfollowMutation = useToastMutation(
    api.follows.deleteMutation({
      successMessage: 'Unfollowed',
      errorMessage: 'Could not unfollow',
    }),
  )

  if (!currentUserId || currentUserId === targetUserId) return null

  const pending = followMutation.isPending || unfollowMutation.isPending

  return (
    <button
      type="button"
      className={existing ? 'outline' : undefined}
      disabled={pending}
      onClick={() => {
        if (existing) {
          unfollowMutation.mutate(existing.id)
        } else {
          followMutation.mutate({ followingId: targetUserId })
        }
      }}
    >
      {pending ? '…' : existing ? 'Following' : 'Follow'}
    </button>
  )
}
