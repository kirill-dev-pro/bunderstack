import { Link, useRouteContext } from '@tanstack/react-router'
import { generate as generateTypeId, type TypeId } from 'bunderstack/typeid'
import * as React from 'react'

import type { Post } from '~/utils/posts'

import { Button } from '~/components/ui/button'
import { UserAvatar } from '~/components/UserAvatar'
import { toast } from '~/lib/toast'

type ReplyComposerProps = {
  user: { id: TypeId<'user'>; name: string; image?: string | null } | null
  replyToId: Post['id']
  placeholder?: string
  onPosted?: () => void
}

export function ReplyComposer({
  user,
  replyToId,
  placeholder,
  onPosted,
}: ReplyComposerProps) {
  const { api } = useRouteContext({ from: '__root__' })
  const [body, setBody] = React.useState('')
  const [posting, setPosting] = React.useState(false)

  if (!user) {
    return (
      <p className="text-muted-foreground border-b p-4 text-sm">
        <Link to="/login" className="text-primary hover:underline">
          Log in
        </Link>{' '}
        to reply.
      </p>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = body.trim()
    if (!text) return
    setPosting(true)
    try {
      const tx = api.posts.collection.insert({
        id: generateTypeId('post'),
        userId: user!.id,
        body: text,
        title: text.slice(0, 80) || 'Reply',
        imageUrl: null,
        replyToId,
        createdAt: new Date(),
      })
      await tx.isPersisted.promise
      setBody('')
      toast.success('Reply posted')
      onPosted?.()
    } catch {
      toast.error('Could not post reply')
    } finally {
      setPosting(false)
    }
  }

  return (
    <form
      className="flex gap-3 border-b p-4"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <UserAvatar name={user.name} image={user.image} size={40} />
      <div className="flex-1 space-y-2">
        <textarea
          className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder ?? 'Post your reply'}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={posting || !body.trim()}>
            {posting ? 'Posting…' : 'Reply'}
          </Button>
        </div>
      </div>
    </form>
  )
}
