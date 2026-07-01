import { createFileRoute } from '@tanstack/react-router'

import { app } from '~/bunderstack'

const handle = ({ request }: { request: Request }) => app.handler(request)

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
})
