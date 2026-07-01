import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const { user } = Route.useRouteContext()
  const primaryCta = user
    ? ({ to: '/canvas', label: 'Open your canvases' } as const)
    : ({ to: '/login', label: 'Start drawing' } as const)

  return (
    <div className="relative isolate overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_20%,rgb(59_130_246/0.35),transparent_32%),radial-gradient(circle_at_80%_10%,rgb(168_85_247/0.24),transparent_28%),linear-gradient(135deg,rgb(15_23_42),rgb(2_6_23))]" />
      <div className="mx-auto grid min-h-[calc(100vh-57px)] w-full max-w-7xl items-center gap-10 px-4 py-12 lg:grid-cols-[1fr_34rem] lg:px-8">
        <section className="max-w-3xl space-y-8">
          <div className="inline-flex rounded-full border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold text-blue-100 backdrop-blur">
            Bunderstack Sync whiteboards
          </div>

          <div className="space-y-5">
            <h1 className="text-5xl font-black tracking-[-0.06em] sm:text-7xl">
              A whiteboard that stays awake.
            </h1>
            <p className="max-w-2xl text-xl leading-8 text-slate-300">
              Sketch rectangles, pan across an open canvas, and watch board
              state flow through Bunderstack realtime collections.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              to={primaryCta.to}
              className="rounded-full bg-white px-6 py-3 font-bold text-slate-950 transition hover:-translate-y-0.5 hover:bg-blue-100"
            >
              {primaryCta.label}
            </Link>
            <Link
              to="/canvas"
              className="rounded-full border border-white/20 px-6 py-3 font-bold text-white transition hover:-translate-y-0.5 hover:bg-white/10"
            >
              View boards
            </Link>
          </div>

          <dl className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {[
              ['Live', 'SSE sync'],
              ['Fast', 'Local collections'],
              ['Open', 'Infinite plane'],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur"
              >
                <dt className="text-sm text-slate-300">{label}</dt>
                <dd className="mt-1 font-black">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section
          aria-label="Whiteboard preview"
          className="relative min-h-120 overflow-hidden rounded-4xl border border-white/15 bg-white shadow-2xl"
        >
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_1px_1px,rgb(148_163_184/0.55)_1px,transparent_0)] bg-size-[28px_28px]" />
          <div className="absolute left-10 top-10 h-24 w-40 -rotate-6 rounded-3xl border-4 border-blue-500 bg-blue-100 shadow-xl" />
          <div className="absolute right-12 top-28 h-28 w-44 rotate-3 rounded-3xl border-4 border-purple-500 bg-purple-100 shadow-xl" />
          <div className="absolute bottom-16 left-24 h-24 w-56 rotate-2 rounded-3xl border-4 border-amber-500 bg-amber-100 shadow-xl" />
          <div className="absolute bottom-8 right-8 rounded-full bg-slate-950 px-4 py-2 text-sm font-bold text-white shadow-xl">
            pan / zoom / sync
          </div>
        </section>
      </div>
    </div>
  )
}
