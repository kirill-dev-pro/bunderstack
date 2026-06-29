import * as React from 'react'

import { api } from '~/api-client'
import { useToastMutation } from '~/hooks/useToastMutation'
import { toast } from '~/utils/oat'

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
      onSuccess: () => {
        toast.success('Following')
      },
      onError: () => {
        toast.error('Could not follow')
      },
    }),
  )

  const unfollowMutation = useToastMutation(
    api.follows.deleteMutation({
      onSuccess: () => {
        toast.success('Unfollowed')
      },
      onError: () => {
        toast.error('Could not unfollow')
      },
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
