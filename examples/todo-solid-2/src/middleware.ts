import { app } from './bunderstack'

/**
 * The mount — and the only one. Start mode's middleware contract is
 * `(Request, next) => Response`, which is exactly `app.handler`, so putting
 * Bunderstack in front of the app is a path check and a delegation: no
 * adapter, no body marshalling, no custom Vite plugin, no second process.
 *
 * The same chain runs in `vite dev`, in `vite preview`, and inside the built
 * Nitro server, so one handler serves `/api` everywhere. During SSR the client
 * skips HTTP altogether and calls `app.handler` in process — see src/api.ts.
 *
 * This module is server-only: the browser bundle never imports it, so
 * Bunderstack and the database stay out of the client.
 */
export default [
  async (request: Request, next: () => Promise<Response>) => {
    if (!new URL(request.url).pathname.startsWith('/api')) return next()
    return app.handler(request)
  },
]
