import { Link, useRouteContext } from '@tanstack/react-router'
import * as React from 'react'
import { generate as generateTypeId, type TypeId } from 'bunderstack/typeid'

import {
  fileIdFromUrl,
  thumbnailUrl,
  type UploadedFile,
} from '~/components/ImageUpload'
import { UserAvatar } from '~/components/UserAvatar'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import { toast } from '~/lib/toast'
import type { Post } from '~/utils/posts'

type ComposePostDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: TypeId<'user'>; name: string; image?: string | null }
  replyToId?: Post['id']
  onPosted?: () => void
}

export function ComposePostDialog({
  open,
  onOpenChange,
  user,
  replyToId,
  onPosted,
}: ComposePostDialogProps) {
  const { api } = useRouteContext({ from: '__root__' })
  const [body, setBody] = React.useState('')
  const [imageUrl, setImageUrl] = React.useState<string | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [posting, setPosting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const reset = () => {
    setBody('')
    setImageUrl(null)
  }

  const previewFileId = fileIdFromUrl(imageUrl)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = body.trim()
    if (!text && !imageUrl) {
      toast.warning('Write something or attach an image')
      return
    }
    setPosting(true)
    try {
      const tx = api.posts.collection.insert({
        id: generateTypeId('post'),
        userId: user.id,
        body: text,
        title: text.slice(0, 80) || 'Post',
        imageUrl: imageUrl ?? null,
        replyToId: replyToId ?? null,
        createdAt: new Date(),
      })
      await tx.isPersisted.promise
      reset()
      onOpenChange(false)
      toast.success('Post published!')
      onPosted?.()
    } catch {
      toast.error('Could not publish post')
    } finally {
      setPosting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New post</DialogTitle>
        </DialogHeader>

        <form className="space-y-3" onSubmit={(e) => void handleSubmit(e)}>
          <div className="flex items-center gap-2">
            <UserAvatar name={user.name} image={user.image} size={40} />
            <span className="font-semibold">{user.name}</span>
          </div>

          <textarea
            className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Share an update…"
            maxLength={500}
          />

          {previewFileId ? (
            <figure className="space-y-2">
              <img
                src={thumbnailUrl(previewFileId, {
                  w: 320,
                  h: 200,
                  format: 'webp',
                })}
                alt="Attachment preview"
                className="rounded-lg border"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setImageUrl(null)}
              >
                Remove image
              </Button>
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
                const uploaded: UploadedFile =
                  await api.files.attachments.upload(file)
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

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? 'Uploading…' : 'Attach image'}
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={posting || uploading}>
                {posting ? 'Posting…' : 'Post'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ComposePostTrigger({
  user,
  onOpen,
}: {
  user: { id: TypeId<'user'>; name: string; image?: string | null } | null
  onOpen: () => void
}) {
  if (!user) {
    return (
      <article className="border-b p-4">
        <p>
          <Link to="/login" className="text-primary hover:underline">
            Log in
          </Link>{' '}
          to share a post with the community.
        </p>
      </article>
    )
  }

  return (
    <article className="border-b p-4">
      <button
        type="button"
        className="text-muted-foreground flex w-full items-center gap-3 text-left"
        onClick={onOpen}
      >
        <UserAvatar name={user.name} image={user.image} size={40} />
        <span>What&apos;s happening?</span>
      </button>
    </article>
  )
}
