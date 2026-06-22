import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const { user } = Route.useRouteContext()

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Bunderstack + TanStack Start</h1>
      <p className="text-gray-500 mb-6">
        Auth, CRUD, and file storage — wired together by Bunderstack and mounted as a single
        <code className="mx-1 px-1 bg-gray-100 dark:bg-gray-800 rounded text-sm">Request → Response</code>
        handler.
      </p>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          <span className="w-24 font-mono text-cyan-600">app.auth</span>
          <span>BetterAuth — email/password sessions, cookie-based</span>
        </div>
        <div className="flex gap-2">
          <span className="w-24 font-mono text-cyan-600">app.db</span>
          <span>Drizzle ORM over libSQL — auto-CRUD at /api/posts</span>
        </div>
        <div className="flex gap-2">
          <span className="w-24 font-mono text-cyan-600">app.storage</span>
          <span>Local file storage — upload/serve at /api/files</span>
        </div>
      </div>
      <div className="mt-8">
        {user ? (
          <Link to="/posts" className="bg-cyan-600 text-white px-4 py-2 rounded text-sm font-semibold">
            Go to Posts →
          </Link>
        ) : (
          <div className="flex gap-3">
            <Link to="/login" className="bg-cyan-600 text-white px-4 py-2 rounded text-sm font-semibold">
              Login
            </Link>
            <Link to="/signup" className="border border-gray-300 px-4 py-2 rounded text-sm font-semibold">
              Sign up
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
