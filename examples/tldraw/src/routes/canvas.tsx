// @ts-nocheck

import { useLiveQuery, eq } from '@tanstack/react-db'
import {
  ClientOnly,
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useRouter,
} from '@tanstack/react-router'
import * as React from 'react'
import { toast } from 'sonner'

import {
  canvasListParams,
  createClientTypeId,
  formatCanvasDate,
} from '~/utils/canvas-data'

export const Route = createFileRoute('/canvas')({
  // Only the canvas list needs an account. Child board routes (/canvas/:id)
  // are shared by URL and open for guests, so the guard is path-exact.
  beforeLoad: ({ context, location }) => {
    if (!context.user && location.pathname === '/canvas') {
      throw redirect({ to: '/login' })
    }
  },
  component: CanvasesPage,
})

function CanvasesPage() {
  const location = useLocation()
  if (location.pathname !== '/canvas') return <Outlet />

  return (
    <ClientOnly
      fallback={
        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <div className="rounded-3xl border bg-white p-8 shadow-sm dark:bg-gray-900">
            Loading canvases...
          </div>
        </div>
      }
    >
      <CanvasesClient />
    </ClientOnly>
  )
}

function CanvasesClient() {
  const router = useRouter()
  const { api, user } = Route.useRouteContext()
  const [name, setName] = React.useState('')
  const params = React.useMemo(() => canvasListParams(user!.id), [user])

  React.useEffect(() => {
    void api.realtime?.subscribe(['canvas', 'shape'])
    void api.canvas.table
      .list(params)
      .then((page) => {
        for (const canvas of page.items) {
          api.canvas.collection.utils.writeUpsert(canvas)
        }
      })
      .catch((error: Error) => toast.error(error.message))
  }, [api.canvas.collection.utils, api.canvas.table, api.realtime, params])

  const { data: canvases = [] } = useLiveQuery((query) =>
    query
      .from({ canvas: api.canvas.collection })
      .where(({ canvas }) => eq(canvas.ownerId, params.ownerId))
      .orderBy(({ canvas }) => canvas.updatedAt, params.order)
      .limit(params.limit)
      .select(({ canvas }) => canvas),
  )

  const title = name.trim() || 'Untitled canvas'

  function createCanvas() {
    const id = createClientTypeId('canvas')
    const now = new Date()

    api.canvas.collection.insert({
      id,
      name: title,
      ownerId: user!.id,
      createdAt: now,
      updatedAt: now,
    })

    setName('')
    toast.success('Canvas created')
    void router.navigate({ to: '/canvas/$id', params: { id } })
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      <section className="overflow-hidden rounded-3xl border bg-white shadow-sm dark:bg-gray-900">
        <div className="grid gap-8 p-6 md:grid-cols-[1fr_22rem] md:p-8">
          <div className="flex flex-col justify-center gap-4">
            <p className="text-sm font-semibold uppercase tracking-[0.24em] text-blue-600">
              Synced boards
            </p>
            <div className="space-y-3">
              <h1 className="text-4xl font-black tracking-tight text-slate-950 dark:text-white">
                Your canvas room.
              </h1>
              <p className="max-w-2xl text-lg text-slate-600 dark:text-slate-300">
                Create a canvas, open it, and keep every board live through
                Bunderstack Sync collections.
              </p>
            </div>
          </div>

          <form
            className="flex flex-col gap-3 rounded-2xl bg-slate-950 p-4 text-white shadow-xl"
            onSubmit={(event) => {
              event.preventDefault()
              createCanvas()
            }}
          >
            <label className="text-sm font-medium">
              New canvas name
              <input
                className="mt-2 w-full rounded-xl border border-white/10 bg-white px-3 py-2 text-slate-950 outline-none ring-blue-400 transition focus:ring-2"
                placeholder="Product map"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="rounded-xl bg-blue-500 px-4 py-2 font-semibold text-white transition hover:bg-blue-400"
            >
              Create and open
            </button>
          </form>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Your canvases</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Synced locally, updated live from the Bunderstack realtime stream.
          </p>
        </div>

        {canvases.length === 0 ? (
          <div className="rounded-3xl border border-dashed bg-white p-8 text-center shadow-sm dark:bg-gray-900">
            <h3 className="text-lg font-semibold">No canvases yet</h3>
            <p className="mt-1 text-slate-500">
              Name one above and it will open as soon as it is created.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {canvases.map((canvas) => (
              <Link
                key={canvas.id}
                to="/canvas/$id"
                params={{ id: canvas.id }}
                className="group rounded-3xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-lg dark:bg-gray-900"
              >
                <div className="mb-6 h-28 overflow-hidden rounded-2xl border bg-[radial-gradient(circle_at_1px_1px,rgb(148_163_184/0.55)_1px,transparent_0)] bg-size-[18px_18px]">
                  <div className="m-5 h-14 w-24 -rotate-6 rounded-xl border-2 border-blue-500 bg-blue-100 shadow-sm transition group-hover:-rotate-3" />
                </div>
                <h3 className="text-lg font-bold text-slate-950 dark:text-white">
                  {canvas.name}
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Updated {formatCanvasDate(canvas.updatedAt)}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
