import type { InferSelect } from 'bunderstack-query'

import { Link } from '@tanstack/react-router'
import * as React from 'react'

import type { user } from '~/schema'

import { api } from '~/api-client'
import { PostImagePreview } from '~/components/ImageLightbox'
import { PostActions } from '~/components/PostActions'
import { PostTime } from '~/components/PostTime'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'
import { closeDialog, showDialog } from '~/utils/oat'
import { countReplies, handleFromEmail, type Post } from '~/utils/posts'

type Author = InferSelect<typeof user>

type PostCardProps = {
  post: Post
  author?: Author
  allPosts: Post[]
  likes: Array<{ id: number; userId: string; postId: number }>
  retweets: Array<{ id: number; userId: string; postId: number }>
  authorMap: Map<string, Author>
  currentUserId: string | null
  /** feed = link to thread; detail = no self-link; reply = compact thread row */
  variant?: 'feed' | 'detail' | 'reply'
}

export function PostCard({
  post,
  author,
  allPosts,
  likes,
  retweets,
  authorMap,
  currentUserId,
  variant = 'feed',
}: PostCardProps) {
  const [editBody, setEditBody] = React.useState(post.body)
  const editDialogRef = React.useRef<HTMLDialogElement>(null)

  const replyCount = countReplies(post.id, allPosts)
  const isOwner = currentUserId === post.userId
  const handle = author ? handleFromEmail(author.email) : 'user'

  const parentPost = post.replyToId
    ? allPosts.find((p) => p.id === post.replyToId)
    : undefined
  const parentAuthor = parentPost ? authorMap.get(parentPost.userId) : undefined

  const updateMutation = useToastMutation(
    api.posts.updateMutation({
      successMessage: 'Post updated',
      errorMessage: 'Could not update post',
      onSuccess: () => closeDialog(editDialogRef.current),
    }),
  )

  const deleteMutation = useToastMutation(
    api.posts.deleteMutation({
      successMessage: 'Post deleted',
      errorMessage: 'Could not delete post',
    }),
  )

  const content = (
    <>
      <header className="post-x-header">
        <div className="post-x-meta">
          {author ? (
            <>
              <Link
                to="/users/$userId"
                params={{ userId: author.id }}
                className="post-x-name"
              >
                {author.name}
              </Link>
              <span className="post-x-handle">@{handle}</span>
            </>
          ) : (
            <span className="post-x-name">Unknown</span>
          )}
          <span className="post-x-dot" aria-hidden>
            ·
          </span>
          {variant === 'feed' || variant === 'reply' ? (
            <Link
              to="/posts/$postId"
              params={{ postId: String(post.id) }}
              className="post-x-time-link"
            >
              <PostTime value={post.createdAt} />
            </Link>
          ) : (
            <PostTime value={post.createdAt} />
          )}
        </div>

        {isOwner ? (
          <div className="post-x-owner-actions">
            <button
              type="button"
              className="outline small"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setEditBody(post.body)
                showDialog(editDialogRef.current)
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="outline small"
              data-variant="danger"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (confirm('Delete this post?')) deleteMutation.mutate(post.id)
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </header>

      {post.replyToId && parentAuthor ? (
        <p className="post-x-replying">
          Replying to{' '}
          <Link to="/users/$userId" params={{ userId: parentAuthor.id }}>
            @{handleFromEmail(parentAuthor.email)}
          </Link>
        </p>
      ) : null}

      <div className="post-x-body">
        <p>{post.body}</p>
        {post.imageUrl ? (
          <PostImagePreview imageUrl={post.imageUrl} alt="Post attachment" />
        ) : null}
      </div>

      <PostActions
        postId={post.id}
        replyCount={replyCount}
        currentUserId={currentUserId}
        likes={likes}
        retweets={retweets}
      />
    </>
  )

  return (
    <article
      className={`post-x${variant === 'reply' ? ' post-x--reply' : ''}${variant === 'detail' ? ' post-x--detail' : ''}`}
    >
      {author ? (
        <Link
          to="/users/$userId"
          params={{ userId: author.id }}
          className="post-x-avatar"
          aria-label={author.name}
        >
          <UserAvatar name={author.name} image={author.image} size={40} />
        </Link>
      ) : (
        <div className="post-x-avatar">
          <UserAvatar name="?" size={40} />
        </div>
      )}

      <div className="post-x-content">
        {variant === 'feed' ? (
          <Link
            to="/posts/$postId"
            params={{ postId: String(post.id) }}
            className="post-x-stretch-link"
          >
            <span className="sr-only">View post</span>
          </Link>
        ) : null}
        {content}
      </div>

      <dialog ref={editDialogRef} closedBy="any">
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault()
            if (!editBody.trim()) return
            updateMutation.mutate({
              id: post.id,
              data: {
                body: editBody.trim(),
                title: editBody.trim().slice(0, 80) || 'Post',
              },
            })
          }}
        >
          <header>
            <h3>Edit post</h3>
          </header>
          <div className="vstack">
            <label>
              Content
              <textarea
                rows={4}
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                required
              />
            </label>
          </div>
          <footer>
            <button
              type="button"
              className="outline"
              onClick={() => closeDialog(editDialogRef.current)}
            >
              Cancel
            </button>
            <button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </footer>
        </form>
      </dialog>
    </article>
  )
}
