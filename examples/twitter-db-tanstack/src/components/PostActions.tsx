import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'

import { useToastMutation } from '~/hooks/useToastMutation'
import { toast } from '~/utils/oat'
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

  const likeCreate = useToastMutation(
    api.likes.createMutation({
      onSuccess: () => toast.success('Liked'),
      onError: () => toast.error('Could not like'),
    }),
  )
  const likeDelete = useToastMutation(
    api.likes.deleteMutation({
      onSuccess: () => toast.success('Unliked'),
      onError: () => toast.error('Could not unlike'),
    }),
  )
  const rtCreate = useToastMutation(
    api.retweets.createMutation({
      onSuccess: () => toast.success('Reposted'),
      onError: () => toast.error('Could not repost'),
    }),
  )
  const rtDelete = useToastMutation(
    api.retweets.deleteMutation({
      onSuccess: () => toast.success('Undone repost'),
      onError: () => toast.error('Could not undo repost'),
    }),
  )

  const pending =
    likeCreate.isPending ||
    likeDelete.isPending ||
    rtCreate.isPending ||
    rtDelete.isPending

  const replyTo = `/posts/${postId}`

  return (
    <div className="post-actions-bar" role="group" aria-label="Post actions">
      <Link
        to="/posts/$postId"
        params={{ postId: String(postId) }}
        className="post-action post-action--reply"
        aria-label="Reply"
      >
        <span aria-hidden>💬</span>
        {replyCount > 0 ? <span>{replyCount}</span> : null}
      </Link>

      <button
        type="button"
        className="post-action post-action--repost"
        disabled={!currentUserId || pending}
        aria-pressed={!!myRt}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!currentUserId) return
          if (myRt) rtDelete.mutate(myRt.id)
          else rtCreate.mutate({ postId })
        }}
      >
        <span aria-hidden>↻</span>
        {rtCount > 0 ? <span>{rtCount}</span> : null}
      </button>

      <button
        type="button"
        className={`post-action post-action--like${myLike ? ' is-active' : ''}`}
        disabled={!currentUserId || pending}
        aria-pressed={!!myLike}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (!currentUserId) return
          if (myLike) likeDelete.mutate(myLike.id)
          else likeCreate.mutate({ postId })
        }}
      >
        <span aria-hidden>{myLike ? '♥' : '♡'}</span>
        {likeCount > 0 ? <span>{likeCount}</span> : null}
      </button>
    </div>
  )
}
