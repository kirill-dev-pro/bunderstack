import type { InferSelect } from 'bunderstack-sync'

import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'

import type { user } from '~/schema'

import { PostImagePreview } from '~/components/ImageLightbox'
import { PostActions } from '~/components/PostActions'
import { PostTime } from '~/components/PostTime'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog'
import { UserAvatar } from '~/components/UserAvatar'
import { toast } from '~/lib/toast'
import {
  countReplies,
  handleFromEmail,
  Like,
  Retweet,
  type Post,
} from '~/utils/posts'

type Author = InferSelect<typeof user>

type PostCardProps = {
  post: Post
  author?: Author
  allPosts: Post[]
  likes: Like[]
  retweets: Retweet[]
  authorMap: Map<Author['id'], Author>
  currentUserId: Author['id'] | null
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
  const { api } = useRouteContext({ from: '__root__' })
  const [editBody, setEditBody] = React.useState(post.body)
  const [editOpen, setEditOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const replyCount = countReplies(post.id, allPosts)
  const isOwner = currentUserId === post.userId
  const handle = author ? handleFromEmail(author.email) : 'user'

  const parentPost = post.replyToId
    ? allPosts.find((p) => p.id === post.replyToId)
    : undefined
  const parentAuthor = parentPost ? authorMap.get(parentPost.userId) : undefined

  async function handleSave() {
    const body = editBody.trim()
    if (!body) return
    setSaving(true)
    try {
      const tx = api.posts.collection.update(post.id, (draft) => {
        draft.body = body
        draft.title = body.slice(0, 80) || 'Post'
      })
      await tx.isPersisted.promise
      toast.success('Post updated')
      setEditOpen(false)
    } catch {
      toast.error('Could not update post')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      const tx = api.posts.collection.delete(post.id)
      await tx.isPersisted.promise
      toast.success('Post deleted')
    } catch {
      toast.error('Could not delete post')
    } finally {
      setDeleting(false)
    }
  }

  const content = (
    <>
      <header className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {author ? (
            <>
              <Link
                to="/users/$userId"
                params={{ userId: author.id }}
                className="font-semibold hover:underline"
              >
                {author.name}
              </Link>
              <span className="text-muted-foreground">@{handle}</span>
            </>
          ) : (
            <span className="font-semibold">Unknown</span>
          )}
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          {variant === 'feed' || variant === 'reply' ? (
            <Link
              to="/posts/$postId"
              params={{ postId: String(post.id) }}
              className="hover:underline"
            >
              <PostTime value={post.createdAt} />
            </Link>
          ) : (
            <PostTime value={post.createdAt} />
          )}
        </div>

        {isOwner ? (
          <div className="relative z-10 flex shrink-0 items-center gap-2">
            <Dialog open={editOpen} onOpenChange={setEditOpen}>
              <DialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setEditBody(post.body)
                  }}
                >
                  Edit
                </Button>
              </DialogTrigger>
              <DialogContent onClick={(e) => e.stopPropagation()}>
                <DialogHeader>
                  <DialogTitle>Edit post</DialogTitle>
                </DialogHeader>
                <textarea
                  className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
                  rows={4}
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  required
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                >
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this post?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deleting}
                    onClick={() => void handleDelete()}
                  >
                    {deleting ? 'Deleting…' : 'Delete'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        ) : null}
      </header>

      {post.replyToId && parentAuthor ? (
        <p className="text-muted-foreground text-sm">
          Replying to{' '}
          <Link
            to="/users/$userId"
            params={{ userId: parentAuthor.id }}
            className="relative z-10 hover:underline"
          >
            @{handleFromEmail(parentAuthor.email)}
          </Link>
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="whitespace-pre-wrap">{post.body}</p>
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
      className={`relative flex gap-3 border-b p-4 ${variant === 'reply' ? 'pl-8' : ''} ${variant === 'detail' ? 'border-b-0' : ''}`}
    >
      {author ? (
        <Link
          to="/users/$userId"
          params={{ userId: author.id }}
          className="relative z-10 shrink-0"
          aria-label={author.name}
        >
          <UserAvatar name={author.name} image={author.image} size={40} />
        </Link>
      ) : (
        <div className="shrink-0">
          <UserAvatar name="?" size={40} />
        </div>
      )}

      <div className="relative min-w-0 flex-1 space-y-2">
        {variant === 'feed' ? (
          <Link
            to="/posts/$postId"
            params={{ postId: String(post.id) }}
            className="absolute inset-0"
          >
            <span className="sr-only">View post</span>
          </Link>
        ) : null}
        {content}
      </div>
    </article>
  )
}
