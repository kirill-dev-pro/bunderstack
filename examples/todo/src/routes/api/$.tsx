import { createFileRoute } from '@tanstack/react-router'
import { createApiHandlers } from 'bunderstack-start'

import { app } from '~/bunderstack'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: createApiHandlers(app),
  },
})
