import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'

import type { Post } from '~/utils/posts'

import {
  uploadFile,
  fileIdFromUrl,
  thumbnailUrl,
  type UploadedFile,
} from '~/components/ImageUpload'
import { UserAvatar } from '~/components/UserAvatar'
import { useToastMutation } from '~/hooks/useToastMutation'
import { closeDialog, showDialog, toast } from '~/utils/oat'

type ComposePostDialogProps = {
  dialogRef: React.RefObject<HTMLDialogElement | null>
  user: { id: string; name: string; image?: string | null }
  replyToId?: Post['id']
  onPosted?: () => void
}

export function ComposePostDialog({
  dialogRef,
  user,
  replyToId,
  onPosted,
}: ComposePostDialogProps) {
  const { api } = useRouteContext({ from: '__root__' })
  const [body, setBody] = React.useState('')
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const createMutation = useToastMutation(
    api.posts.createMutation({
      onSuccess: () => {
        setBody('')
        setImageUrl(null)
        closeDialog(dialogRef.current)
        toast.success('Post published!')
        onPosted?.()
      },
      onError: () => {
        toast.error('Could not publish post')
      },
    }),
  )

  const reset = () => {
    setBody('')
    setImageUrl(null)
  }

  const previewFileId = fileIdFromUrl(imageUrl)

  return (
    <dialog ref={dialogRef} closedby="any" onClose={reset}>
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          const text = body.trim()
          if (!text && !imageUrl) {
            toast.warning('Write something or attach an image')
            return
          }
          createMutation.mutate({
            body: text,
            title: text.slice(0, 80) || 'Post',
            imageUrl: imageUrl ?? undefined,
            ...(replyToId != null ? { replyToId } : {}),
          })
        }}
      >
        <header>
          <h3>New post</h3>
        </header>

        <div className="compose-body vstack">
          <div className="compose-author">
            <UserAvatar name={user.name} image={user.image} size={40} />
            <span>{user.name}</span>
          </div>

          <label>
            What&apos;s happening?
            <textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Share an update…"
              maxLength={500}
            />
          </label>

          {previewFileId ? (
            <figure className="compose-preview">
              <img
                src={thumbnailUrl(previewFileId, {
                  w: 320,
                  h: 200,
                  format: 'webp',
                })}
                alt="Attachment preview"
              />
              <button
                type="button"
                className="outline small"
                onClick={() => setImageUrl(null)}
              >
                Remove image
              </button>
            </figure>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              setUploading(true)
              try {
                const uploaded: UploadedFile = await uploadFile(file)
                setImageUrl(uploaded.url)
                toast.success('Image attached')
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : 'Upload failed',
                )
              } finally {
                setUploading(false)
                if (fileInputRef.current) fileInputRef.current.value = ''
              }
            }}
          />
        </div>

        <footer className="compose-footer">
          <button
            type="button"
            className="outline"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? 'Uploading…' : 'Attach image'}
          </button>
          <div>
            <button
              type="button"
              className="outline"
              onClick={() => closeDialog(dialogRef.current)}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || uploading}
            >
              {createMutation.isPending ? 'Posting…' : 'Post'}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  )
}

export function ComposePostTrigger({
  user,
  onOpen,
}: {
  user: { id: string; name: string; image?: string | null } | null
  onOpen: () => void
}) {
  if (!user) {
    return (
      <article className="card compose-prompt">
        <p>
          <Link to="/login">Log in</Link> to share a post with the community.
        </p>
      </article>
    )
  }

  return (
    <article className="card compose-prompt">
      <button type="button" className="compose-trigger" onClick={onOpen}>
        <UserAvatar name={user.name} image={user.image} size={40} />
        <span>What&apos;s happening?</span>
      </button>
    </article>
  )
}
