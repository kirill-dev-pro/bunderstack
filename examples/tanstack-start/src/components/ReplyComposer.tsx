import { Link } from '@tanstack/react-router'
import * as React from 'react'

import { api } from '~/api-client'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'

type ReplyComposerProps = {
  user: { id: string; name: string; image?: string | null } | null
  replyToId: number
  placeholder?: string
  onPosted?: () => void
}

export function ReplyComposer({
  user,
  replyToId,
  placeholder,
  onPosted,
}: ReplyComposerProps) {
  const [body, setBody] = React.useState('')

  const createMutation = useToastMutation(
    api.posts.createMutation({
      successMessage: 'Reply posted',
      errorMessage: 'Could not post reply',
      onSuccess: () => {
        setBody('')
        onPosted?.()
      },
    }),
  )

  if (!user) {
    return (
      <p className="reply-login-prompt">
        <Link to="/login">Log in</Link> to reply.
      </p>
    )
  }

  return (
    <form
      className="reply-composer"
      onSubmit={(e) => {
        e.preventDefault()
        const text = body.trim()
        if (!text) return
        createMutation.mutate({
          body: text,
          title: text.slice(0, 80) || 'Reply',
          replyToId,
        })
      }}
    >
      <UserAvatar name={user.name} image={user.image} size={40} />
      <div className="reply-composer-main">
        <textarea
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder ?? 'Post your reply'}
        />
        <button
          type="submit"
          disabled={createMutation.isPending || !body.trim()}
        >
          {createMutation.isPending ? 'Posting…' : 'Reply'}
        </button>
      </div>
    </form>
  )
}
