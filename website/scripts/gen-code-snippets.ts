/**
 * Pre-renders the landing page code snippets with shiki + twoslash: syntax
 * highlighting plus real TypeScript hover info, computed at build time
 * against the actual bunderstack package sources (resolved via `paths`).
 * Output: src/lib/code-snippets.gen.json — { [name]: html }.
 *
 * Wired as predev/prebuild alongside gen-docs-manifest.ts.
 */
import { join } from 'node:path'

import { transformerTwoslash } from '@shikijs/twoslash'
import { createHighlighter } from 'shiki'
import ts from 'typescript'

const root = join(import.meta.dir, '..')
const outFile = join(root, 'src/lib/code-snippets.gen.json')

/** Hidden context shared by snippets: a schema and a configured app. */
const SCHEMA_FILE = `// @filename: schema.ts
import { sqliteTable, integer, text } from 'bunderstack'
export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
  replyToId: text('replyToId'),
  createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
})
`

const APP_FILE = `// @filename: bunderstack.ts
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'
export const app = createBunderstack({
  schema,
  access: { posts: { ownerColumn: 'userId', searchableColumns: ['title'], filterableColumns: ['replyToId'], sortableColumns: ['createdAt', 'id'] } },
  storage: { local: './uploads', defaultBucket: 'images', buckets: { images: {} } },
  realtime: true,
})
export type App = typeof app
`

const CLIENT_PRELUDE = `// @filename: api-client.ts
import { QueryClient } from '@tanstack/react-query'
const queryClient = new QueryClient()
`

const snippets: Record<string, string> = {
  server: `${SCHEMA_FILE}// @filename: bunderstack.ts
// ---cut---
import { createBunderstack } from 'bunderstack'
import * as schema from './schema'

export const app = createBunderstack({
  schema,
  access: { posts: { ownerColumn: 'userId' } },
  storage: {
    local: './uploads',
    buckets: { images: {} },
  },
  realtime: true,
})

export type App = typeof app`,

  query: `${SCHEMA_FILE}${APP_FILE}${CLIENT_PRELUDE}declare const file: File
// ---cut---
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

const api = createClient<App>({ queryClient })

const page = await api.posts.list({ limit: 20 })
const post = await api.posts.create({ title: 'hello' })
await api.files.images.upload(file)`,

  sync: `${SCHEMA_FILE}${APP_FILE}${CLIENT_PRELUDE}// ---cut---
import { createSyncClient } from 'bunderstack-sync'
import type { App } from './bunderstack'

const api = createSyncClient<App>({ queryClient })

const feed = api.posts.scopedCollection({
  filter: { replyToId: null },
  sort: 'createdAt',
  order: 'desc',
})
await feed.loadMore()`,

  crud: `${SCHEMA_FILE}${APP_FILE}
// @filename: server.ts
// ---cut---
import { app } from './bunderstack'

Bun.serve({ fetch: app.handler })
// GET    /api/posts       list, paginate, ?q= search
// POST   /api/posts       create (owner from session)
// PATCH  /api/posts/:id   update (owner only)
// DELETE /api/posts/:id   delete (owner only)`,

  access: `${SCHEMA_FILE}
// @filename: access.ts
// ---cut---
import { defineAccess } from 'bunderstack/access'
import * as schema from './schema'

export const access = defineAccess(schema, {
  posts: {
    ownerColumn: 'userId',
    list: 'public',
    create: 'authenticated',
    update: 'owner',
    searchableColumns: ['title'],
  },
})`,

  auth: `${SCHEMA_FILE}${APP_FILE}
// @filename: handler.ts
declare const request: Request
// ---cut---
import { app } from './bunderstack'

const session = await app.auth.api.getSession({
  headers: request.headers,
})
// BetterAuth, wired to your db: sign-up, sessions,
// OAuth — /api/auth/* is already mounted`,

  files: `${SCHEMA_FILE}${APP_FILE}${CLIENT_PRELUDE}declare const file: File
// ---cut---
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

const api = createClient<App>({ queryClient })

const uploaded = await api.files.images.upload(file)
const thumb = api.files.images.url(uploaded.fileId, {
  w: 320,
  format: 'webp',
})`,

  realtime: `${SCHEMA_FILE}${APP_FILE}${CLIENT_PRELUDE}// ---cut---
import { createSyncClient } from 'bunderstack-sync'
import type { App } from './bunderstack'

const api = createSyncClient<App>({ queryClient })

await api.realtime?.subscribe(['posts'])
// broadcast-on-write: every create/update/delete
// lands in your collections, live over SSE`,

  inference: `${SCHEMA_FILE}${APP_FILE}${CLIENT_PRELUDE}// @errors: 2339
// ---cut---
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

const api = createClient<App>({ queryClient })

api.posts // inferred from schema + access
api.secrets // not in the schema — the client knows`,

  escape: `${SCHEMA_FILE}${APP_FILE}
// @filename: custom.ts
// ---cut---
import { app } from './bunderstack'
import { desc } from 'bunderstack'
import * as schema from './schema'

const { db, auth, router } = app // the real instances

const latest = await db // raw drizzle — no query wrapper
  .select()
  .from(schema.posts)
  .orderBy(desc(schema.posts.createdAt))
  .limit(5)

router.get('/api/digest', (c) => c.json({ latest }))`,
}

const highlighter = await createHighlighter({
  themes: ['min-light'],
  langs: ['ts'],
})

const twoslash = transformerTwoslash({
  twoslashOptions: {
    compilerOptions: {
      strict: true,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      types: ['bun'],
      baseUrl: root,
      paths: {
        bunderstack: ['../packages/bunderstack/src/index.ts'],
        'bunderstack/*': ['../packages/bunderstack/src/*.ts'],
        'bunderstack-query': ['../packages/bunderstack-query/src/index.ts'],
        'bunderstack-sync': ['../packages/bunderstack-sync/src/index.ts'],
      },
    },
  },
})

/** The part of a snippet the reader sees (and copies): after the last cut. */
function visibleSource(code: string): string {
  const cut = code.lastIndexOf('// ---cut---')
  const start = cut === -1 ? 0 : code.indexOf('\n', cut) + 1
  return code
    .slice(start)
    .split('\n')
    .filter((line) => !line.startsWith('// @'))
    .join('\n')
    .trim()
}

/**
 * When TypeScript can't resolve the package sources (e.g. the root workspace
 * node_modules is missing in CI), twoslash doesn't error — every hover just
 * degrades to `any`. Fail the build instead of deploying that.
 */
function assertNoAnyHovers(name: string, html: string) {
  const anyHover = /:\s*any\b|&#x3C;\s*any\b|<\s*any\b/
  if (anyHover.test(html)) {
    console.error(
      `snippet "${name}": hover types degraded to \`any\` — package sources ` +
        `didn't resolve. Run \`bun install\` at the repo root and retry.`,
    )
    process.exit(1)
  }
}

const out: Record<string, { html: string; code: string }> = {}
for (const [name, code] of Object.entries(snippets)) {
  const html = highlighter.codeToHtml(code, {
    lang: 'ts',
    theme: 'min-light',
    transformers: [twoslash],
  })
  assertNoAnyHovers(name, html)
  out[name] = { html, code: visibleSource(code) }
  console.log(`snippet ok: ${name}`)
}

await Bun.write(outFile, JSON.stringify(out, null, 2))
console.log(`code-snippets: ${Object.keys(out).length} → src/lib/code-snippets.gen.json`)
