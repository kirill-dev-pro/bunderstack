import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import type { IncomingMessage } from 'node:http'
import { defineConfig, type Plugin } from 'vite'

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }
  return headers
}

function bunderstackApiDevMiddleware(): Plugin {
  return {
    name: 'bunderstack-api-dev-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url ?? ''
        if (!path.startsWith('/api/')) return next()

        try {
          const { app } = await import('./src/bunderstack')
          const origin = `http://${req.headers.host ?? 'localhost:3000'}`
          const method = req.method ?? 'GET'
          const init: RequestInit & { duplex?: 'half' } = {
            method,
            headers: requestHeaders(req),
          }
          if (method !== 'GET' && method !== 'HEAD') {
            init.body = req as unknown as BodyInit
            init.duplex = 'half'
          }

          const response = await app.handler(new Request(new URL(path, origin), init))
          res.statusCode = response.status

          const getSetCookie = (
            response.headers as Headers & { getSetCookie?: () => string[] }
          ).getSetCookie
          const setCookie = getSetCookie?.call(response.headers) ?? []
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value)
          })
          if (setCookie.length) res.setHeader('set-cookie', setCookie)

          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (err) {
          next(err)
        }
      })
    },
  }
}

export default defineConfig({
  // server: {
  //   port: 3000,
  //   fs: { allow: ['../..'] },
  // },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    bunderstackApiDevMiddleware(),
    devtools(),
    tanstackStart({
      srcDirectory: 'src',
    }),
    viteReact(),
    nitro({ preset: 'bun' }),
  ],
})
