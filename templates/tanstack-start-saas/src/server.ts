import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { withTelemetry } from 'bunderstack/start'
import { join } from 'node:path'

import { app } from './bunderstack'

const handler = createStartHandler(defaultStreamHandler)

export default {
  // Server renders are timed and their failures reported to the host when it
  // supplies the telemetry variables; without them this is a plain fetch.
  fetch: withTelemetry(app, async (req: Request) => {
    const url = new URL(req.url)

    // Serve static client assets and files from dist/client
    if (url.pathname.startsWith('/assets/') || url.pathname.includes('.')) {
      const filePath = join(process.cwd(), 'dist/client', url.pathname)
      const file = Bun.file(filePath)
      if (await file.exists()) {
        return new Response(file)
      }
    }

    return handler(req)
  }),
}
