import { ClientOnly, createFileRoute, redirect } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import * as React from 'react'
import type { TypeId } from 'bunderstack/typeid'

import { AppShell } from '~/components/AppShell'
import {
  AVATARS_BUCKET,
  ImageUpload,
  thumbnailUrl,
  type UploadedFile,
} from '~/components/ImageUpload'
import { Button } from '~/components/ui/button'
import { Card, CardContent } from '~/components/ui/card'
import { toast } from '~/lib/toast'

export const Route = createFileRoute('/profile')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
  },
  component: ProfilePage,
})

function ProfilePage() {
  const { user } = Route.useRouteContext()

  return (
    <AppShell user={user}>
      <ClientOnly
        fallback={
          <div className="text-muted-foreground p-4 text-sm">Loading…</div>
        }
      >
        <ProfileSettings userId={user!.id} />
      </ClientOnly>
    </AppShell>
  )
}

// useLiveQuery's useSyncExternalStore call has no getServerSnapshot arg — it
// cannot run during SSR (@tanstack/react-db@0.1.91). Isolated in its own
// component so the hook is never invoked server-side.
function ProfileSettings({ userId }: { userId: TypeId<'user'> }) {
  const { api } = Route.useRouteContext()
  const [about, setAbout] = React.useState('')
  const [avatarPending, setAvatarPending] = React.useState(false)
  const [aboutPending, setAboutPending] = React.useState(false)

  // Scoped to just this one id — the general api.user.collection only syncs
  // its default limit, and the signed-in user isn't guaranteed to be in that
  // window once the user table is larger than ~100 rows.
  const ownUserCollection = api.user.collectionByIds([userId])
  const { data: matches } = useLiveQuery(
    (q) => q.from({ user: ownUserCollection }),
    [ownUserCollection],
  )
  const profile = matches?.[0]

  React.useEffect(() => {
    if (profile?.about != null) setAbout(profile.about)
  }, [profile?.about])

  async function updateAvatar(image: string | null) {
    setAvatarPending(true)
    try {
      const tx = api.user.collection.update(userId, (draft) => {
        draft.image = image
      })
      await tx.isPersisted.promise
      toast.success('Avatar updated')
    } catch {
      toast.error('Could not update avatar')
    } finally {
      setAvatarPending(false)
    }
  }

  async function handleSaveAbout(e: React.FormEvent) {
    e.preventDefault()
    setAboutPending(true)
    try {
      const tx = api.user.collection.update(userId, (draft) => {
        draft.about = about.trim()
      })
      await tx.isPersisted.promise
      toast.success('Bio updated')
    } catch {
      toast.error('Could not update bio')
    } finally {
      setAboutPending(false)
    }
  }

  if (!profile) return null

  const avatarFileId =
    profile.image?.replace(/^\/api\/files\//, '').split('?')[0] ?? null

  return (
    <div className="space-y-6 p-4">
      <header>
        <h1 className="text-xl font-bold">Profile settings</h1>
        <p className="text-muted-foreground text-sm">
          Update your avatar and bio — searchable via{' '}
          <code>GET /api/user?q=</code>.
        </p>
      </header>

      <Card>
        <CardContent className="flex gap-4">
          {avatarFileId ? (
            <img
              src={thumbnailUrl(avatarFileId, {
                w: 128,
                h: 128,
                format: 'webp',
              })}
              alt="Avatar"
              width={128}
              height={128}
              className="rounded-full"
            />
          ) : (
            <p className="text-muted-foreground">No avatar</p>
          )}

          <div className="space-y-2">
            <ImageUpload
              label="Avatar"
              bucket={AVATARS_BUCKET}
              onUploaded={(file: UploadedFile) => updateAvatar(file.url)}
              disabled={avatarPending}
            />
            {profile.image ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={avatarPending}
                onClick={() => void updateAvatar(null)}
              >
                Remove avatar
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => void handleSaveAbout(e)}
          >
            <div className="space-y-1.5">
              <label htmlFor="about" className="text-sm font-medium">
                Bio (searchable)
              </label>
              <textarea
                id="about"
                className="border-input focus-visible:ring-ring w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none"
                rows={3}
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                placeholder="Tell people what you build with Bunderstack…"
              />
            </div>
            <Button type="submit" disabled={aboutPending}>
              Save bio
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
