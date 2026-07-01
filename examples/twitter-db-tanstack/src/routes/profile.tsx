import { useQuery } from '@tanstack/react-query'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import * as React from 'react'

import { AppShell } from '~/components/AppShell'
import {
  AVATARS_BUCKET,
  ImageUpload,
  thumbnailUrl,
} from '~/components/ImageUpload'
import { useToastMutation } from '~/hooks/useToastMutation'
import { toast } from '~/utils/oat'

export const Route = createFileRoute('/profile')({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: '/login' })
  },
  loader: async ({ context: { queryClient, api, user } }) => {
    await queryClient.ensureQueryData(api.user.getQuery(user!.id))
  },
  component: ProfilePage,
})

function ProfilePage() {
  const { api, user } = Route.useRouteContext()
  const router = useRouter()
  const { data: profile } = useQuery(api.user.getQuery(user!.id))
  const [about, setAbout] = React.useState('')

  React.useEffect(() => {
    if (profile?.about != null) setAbout(profile.about)
  }, [profile?.about])

  const avatarMutation = useToastMutation(
    api.user.updateMutation({
      onSuccess: () => {
        router.invalidate()
        toast.success('Avatar updated')
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  const aboutMutation = useToastMutation(
    api.user.updateMutation({
      onSuccess: () => {
        router.invalidate()
        toast.success('Bio updated')
      },
      onError: (error) => {
        toast.error(error.message)
      },
    }),
  )

  if (!user) return null

  const avatarFileId =
    user.image?.replace(/^\/api\/files\//, '').split('?')[0] ?? null

  return (
    <AppShell user={user}>
      <header>
        <h1>Profile settings</h1>
        <p>
          Update your avatar and bio — searchable via{' '}
          <code>GET /api/user?q=</code>.
        </p>
      </header>

      <article className="card vstack">
        <div className="profile-card">
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
              className="avatar-preview"
            />
          ) : (
            <p>No avatar</p>
          )}

          <div className="vstack">
            <ImageUpload
              label="Avatar"
              bucket={AVATARS_BUCKET}
              onUploaded={async (file) => {
                await avatarMutation.mutateAsync({
                  id: user.id,
                  data: { image: file.url },
                })
              }}
              disabled={avatarMutation.isPending}
            />
            {user.image ? (
              <button
                type="button"
                data-variant="danger"
                className="outline"
                disabled={avatarMutation.isPending}
                onClick={() =>
                  avatarMutation.mutate({ id: user.id, data: { image: null } })
                }
              >
                Remove avatar
              </button>
            ) : null}
          </div>
        </div>

        <form
          className="vstack"
          onSubmit={(e) => {
            e.preventDefault()
            aboutMutation.mutate({ id: user.id, data: { about: about.trim() } })
          }}
        >
          <label>
            Bio (searchable)
            <textarea
              rows={3}
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              placeholder="Tell people what you build with Bunderstack…"
            />
          </label>
          <button type="submit" disabled={aboutMutation.isPending}>
            Save bio
          </button>
        </form>
      </article>
    </AppShell>
  )
}
