import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'
import { join } from 'node:path'

const handler = createStartHandler(defaultStreamHandler)

export default {
  async fetch(req: Request) {
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
  },
}
