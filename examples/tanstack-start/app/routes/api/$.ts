import { createServerFileRoute } from '@tanstack/start'
import { app } from '../../../bunderstack'

export const ServerRoute = createServerFileRoute('/api/$').methods({
  GET:    ({ request }) => app.handler(request),
  POST:   ({ request }) => app.handler(request),
  PATCH:  ({ request }) => app.handler(request),
  DELETE: ({ request }) => app.handler(request),
})
