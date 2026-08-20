import solid from '@solidjs/vite-plugin'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    // Start mode owns the entries: no index.html and no mount file — the
    // plugin generates them around src/App.tsx and src/Document.tsx.
    //
    // `middleware` is the whole Bunderstack integration. Its contract is
    // `(Request, next) => Response`, which is already `app.handler`'s shape,
    // so src/middleware.ts is six lines — and it is the same handler in dev,
    // in preview, and in production. No second server to keep in sync.
    //
    // `ssr: true` is what keeps that handler alive after a build: in client
    // mode the build emits `dist/server` and then deletes it, leaving static
    // assets and no way to serve /api without a hand-written server.
    solid({
      start: { middleware: './src/middleware.ts' },
      ssr: true,
    }),

    // Nitro adopts Solid's `ssr` environment and turns its Fetchable handler
    // into a deployable server — `.output/server/index.mjs` — which serves the
    // built client assets and dispatches everything else, pages and /api
    // alike, through that one handler.
    //
    // `serverEntry: false` tells Nitro to use Solid's generated entry instead
    // of expecting one in the project. Change the preset to target another
    // host; see https://nitro.build/config.
    nitro({ serverEntry: false, preset: 'bun' }),
  ],
  server: {
    // The example imports `bunderstack` from the workspace root.
    fs: { allow: ['../..'] },
  },
})
