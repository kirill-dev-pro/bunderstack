import { app } from './bunderstack'

/**
 * The mount — the same one-handler story as todo-solid-2: Start mode's
 * middleware contract is `(Request, next) => Response`, which is already
 * `app.handler`'s shape, so /api is a path check and a delegation. The browser
 * bundle never imports this module.
 */
export default [
  async (request: Request, next: () => Promise<Response>) => {
    if (!new URL(request.url).pathname.startsWith('/api')) return next()
    return app.handler(request)
  },
]
