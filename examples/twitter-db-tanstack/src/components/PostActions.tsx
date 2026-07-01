import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'
import { generateTypeId } from 'bunderstack'
import { Heart, MessageCircle, Repeat2 } from 'lucide-react'

import { toast } from '~/lib/toast'
import type { Like, Post, Retweet } from '~/utils/posts'

type PostActionsProps = {
  postId: Post['id']
  replyCount: number
  currentUserId: Like['userId'] | null
  likes: Like[]
  retweets: Retweet[]
}

export function PostActions({
  postId,
  replyCount,
  currentUserId,
  likes,
  retweets,
}: PostActionsProps) {
  const { api } = useRouteContext({ from: '__root__' })
  const [pending, setPending] = React.useState(false)

  const myLike = React.useMemo(
    () => likes.find((r) => r.postId === postId && r.userId === currentUserId),
    [likes, postId, currentUserId],
  )
  const myRt = React.useMemo(
    () =>
      retweets.find((r) => r.postId === postId && r.userId === currentUserId),
    [retweets, postId, currentUserId],
  )
  const likeCount = likes.filter((r) => r.postId === postId).length
  const rtCount = retweets.filter((r) => r.postId === postId).length

  async function toggleLike() {
    if (!currentUserId) return
    setPending(true)
    try {
      if (myLike) {
        await api.likes.collection.delete(myLike.id).isPersisted.promise
        toast.success('Unliked')
      } else {
        await api.likes.collection.insert({
          id: generateTypeId('like'),
          userId: currentUserId,
          postId,
          createdAt: new Date(),
        }).isPersisted.promise
        toast.success('Liked')
      }
    } catch {
      toast.error(myLike ? 'Could not unlike' : 'Could not like')
    } finally {
      setPending(false)
    }
  }

  async function toggleRetweet() {
    if (!currentUserId) return
    setPending(true)
    try {
      if (myRt) {
        await api.retweets.collection.delete(myRt.id).isPersisted.promise
        toast.success('Undone repost')
      } else {
        await api.retweets.collection.insert({
          id: generateTypeId('retweet'),
          userId: currentUserId,
          postId,
          createdAt: new Date(),
        }).isPersisted.promise
        toast.success('Reposted')
      }
    } catch {
      toast.error(myRt ? 'Could not undo repost' : 'Could not repost')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="text-muted-foreground flex items-center gap-6"
      role="group"
      aria-label="Post actions"
    >
      <Link
        to="/posts/$postId"
        params={{ postId: String(postId) }}
        className="hover:text-foreground flex items-center gap-1"
        aria-label="Reply"
      >
        <MessageCircle className="size-4" aria-hidden />
        {replyCount > 0 ? <span className="text-sm">{replyCount}</span> : null}
      </Link>

      <button
        type="button"
        className="hover:text-foreground flex items-center gap-1 disabled:opacity-50"
        disabled={!currentUserId || pending}
        aria-pressed={!!myRt}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void toggleRetweet()
        }}
      >
        <Repeat2 className={`size-4 ${myRt ? 'text-green-600' : ''}`} aria-hidden />
        {rtCount > 0 ? <span className="text-sm">{rtCount}</span> : null}
      </button>

      <button
        type="button"
        className="hover:text-foreground flex items-center gap-1 disabled:opacity-50"
        disabled={!currentUserId || pending}
        aria-pressed={!!myLike}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void toggleLike()
        }}
      >
        <Heart
          className={`size-4 ${myLike ? 'fill-red-500 text-red-500' : ''}`}
          aria-hidden
        />
        {likeCount > 0 ? <span className="text-sm">{likeCount}</span> : null}
      </button>
    </div>
  )
}
