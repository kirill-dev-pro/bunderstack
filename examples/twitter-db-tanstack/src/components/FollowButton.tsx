import { useRouteContext } from '@tanstack/react-router'
import * as React from 'react'
import type { InferSelect } from 'bunderstack-sync'
import { generateTypeId } from 'bunderstack'

import { toast } from '~/lib/toast'
import { Button } from '~/components/ui/button'
import type { follows, user } from '~/schema'

type Follow = InferSelect<typeof follows>
type User = InferSelect<typeof user>

type FollowButtonProps = {
  currentUserId: User['id'] | null
  targetUserId: User['id']
  follows: Follow[]
}

export function FollowButton({
  currentUserId,
  targetUserId,
  follows,
}: FollowButtonProps) {
  const { api } = useRouteContext({ from: '__root__' })
  const [pending, setPending] = React.useState(false)

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

  if (!currentUserId || currentUserId === targetUserId) return null

  async function handleFollow() {
    setPending(true)
    try {
      const tx = api.follows.collection.insert({
        id: generateTypeId('follow'),
        followerId: currentUserId!,
        followingId: targetUserId,
        createdAt: new Date(),
      })
      await tx.isPersisted.promise
      toast.success('Following')
    } catch {
      toast.error('Could not follow')
    } finally {
      setPending(false)
    }
  }

  async function handleUnfollow() {
    if (!existing) return
    setPending(true)
    try {
      const tx = api.follows.collection.delete(existing.id)
      await tx.isPersisted.promise
      toast.success('Unfollowed')
    } catch {
      toast.error('Could not unfollow')
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant={existing ? 'outline' : 'default'}
      size="sm"
      disabled={pending}
      onClick={() => void (existing ? handleUnfollow() : handleFollow())}
    >
      {pending ? '…' : existing ? 'Following' : 'Follow'}
    </Button>
  )
}
