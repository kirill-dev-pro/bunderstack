import { createFileRoute } from '@tanstack/react-router'

/**
 * Source route for the SPA shell (see `spa.maskPath` in vite.config.ts).
 *
 * The shell is the HTML served for any URL without a prerendered page; it
 * boots the client router, which then renders the real route or the 404.
 * It needs a route of its own because the mask path is prerendered like any
 * other page — and it must not be the landing page, or the empty-bodied shell
 * would overwrite the prerendered landing markup at index.html.
 *
 * The build writes it to `_shell.html` only, so `/shell` is never served.
 */
export const Route = createFileRoute('/shell')({
  head: () => ({
    meta: [{ title: 'bunderstack' }],
  }),
  component: () => null,
})
