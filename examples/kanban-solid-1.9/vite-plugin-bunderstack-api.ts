import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type BunResponse = Response & {
  _toNodeResponse?: (res: ServerResponse) => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? Buffer.concat(chunks) : undefined
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

async function sendResponse(res: ServerResponse, response: BunResponse) {
  if (typeof response._toNodeResponse === 'function') {
    await response._toNodeResponse(res)
    return
  }

  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.end(Buffer.from(await response.bytes()))
}

async function loadHandler(server: ViteDevServer) {
  const entry = pathToFileURL(
    resolve(server.config.root, 'src/bunderstack.ts'),
  ).href
  const mod = await import(entry)
  return mod.app.handler as (req: Request) => Promise<BunResponse>
}

/** Dev-only: forward /api/* to Bunderstack before Vite's SPA fallback. */
export function bunderstackApi(): Plugin {
  let handler: ((req: Request) => Promise<BunResponse>) | undefined

  return {
    name: 'bunderstack-api',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith('/api')) return next()

        try {
          if (!handler) handler = await loadHandler(server)

          const host = req.headers.host ?? 'localhost'
          const body = await readBody(req)
          const request = new Request(`http://${host}${url}`, {
            method: req.method,
            headers: toHeaders(req),
            ...(body ? { body } : {}),
          })

          await sendResponse(res, await handler(request))
        } catch (err) {
          next(err as Error)
        }
      })
    },
  }
}
