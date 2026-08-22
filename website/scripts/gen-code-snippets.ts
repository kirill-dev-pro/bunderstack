import { transformerTwoslash } from '@shikijs/twoslash'
import { dirname, join } from 'node:path'
import { createHighlighter } from 'shiki'
import ts from 'typescript'

const root = join(import.meta.dir, '..')
const outFile = join(root, 'src/lib/code-snippets.gen.json')
const drizzleOrmDir = dirname(
  Bun.resolveSync(
    'drizzle-orm/package.json',
    join(root, '../packages/bunderstack'),
  ),
)

const APP_FILE = `// @filename: bunderstack.ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

export const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: libsql() },
  auth: { secret: process.env.AUTH_SECRET! },
  access: { posts: { ownerColumn: 'userId' } },
  realtime: true,
  api: (o) => ({
    stats: o.protected.handler(async ({ context }) => ({
      total: 12,
      requestedBy: context.user.id,
    })),
  }),
})

export type App = typeof app
`

const CLIENT_FILE = `// @filename: api-client.ts
import { QueryClient } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })
`

const snippets: Record<string, string> = {
  declaration: `// @filename: bunderstack.ts
// ---cut---
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as v from 'valibot'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: libsql() },
  auth: { secret: process.env.AUTH_SECRET! },
  access: { posts: { ownerColumn: 'userId' } },
  env: { client: { PUBLIC_APP_NAME: v.optional(v.string(), 'Example') } },
  storage: { local: true, buckets: { images: { transforms: true } } },
  email: { from: 'hello@example.com' },
  realtime: true,
  jobs: (j) =>
    j.define({
      digest: j.cron({
        schedule: '0 9 * * *',
        handler: async (_run, ctx) => {
          await ctx.email.send({
            to: 'team@example.com',
            subject: ctx.env.PUBLIC_APP_NAME,
            text: 'Daily digest',
          })
        },
      }),
    }),
  api: (o) => ({
    stats: o.protected.handler(async ({ context }) => ({
      total: 12,
      requestedBy: context.user.id,
    })),
  }),
})

export type App = typeof app`,

  procedure: `// @filename: bunderstack.ts
// ---cut---
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

const posts = sqliteTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: libsql() },
  realtime: true,
  api: (o) => ({
    stats: o.protected.handler(async ({ context }) => ({
      total: 12,
      requestedBy: context.user.id,
    })),
  }),
})

export type App = typeof app`,

  client: `${APP_FILE}// @filename: client.ts
// ---cut---
import { QueryClient } from '@tanstack/react-query'
import { createClient } from 'bunderstack-query'
import type { App } from './bunderstack'

const queryClient = new QueryClient()
const api = createClient<App>({ queryClient })
const result = await api.stats.call()
//    ^?

result.total
result.requestedBy`,

  realtime: `${APP_FILE}${CLIENT_FILE}// @filename: realtime.ts
// ---cut---
import { syncRealtime } from 'bunderstack-query'
import { api, queryClient } from './api-client'

const connection = syncRealtime({
  api,
  queryClient,
  tables: ['posts'],
})

// Publisher resume, heartbeat, and backoff stay inside the transport.
// Call this only when the application client is disposed:
connection.close()`,
}

const highlighter = await createHighlighter({
  themes: ['min-dark'],
  langs: ['ts'],
})

const twoslash = transformerTwoslash({
  // `^?` queries render on their own line so the popup takes real layout
  // space instead of covering the code beneath it.
  rendererRich: { queryRendering: 'line' },
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
        'bunderstack-query/*': ['../packages/bunderstack-query/src/*.ts'],
        'drizzle-orm': [drizzleOrmDir],
        'drizzle-orm/*': [join(drizzleOrmDir, '*')],
      },
    },
  },
})

function visibleSource(code: string): string {
  const cut = code.lastIndexOf('// ---cut---')
  const start = cut === -1 ? 0 : code.indexOf('\n', cut) + 1
  return code
    .slice(start)
    .split('\n')
    .filter((line) => !line.startsWith('// @') && !line.includes('^?'))
    .join('\n')
    .trim()
}

function assertHealthyTypes(name: string, html: string) {
  if (/:\s*any\b|&#x3C;\s*any\b|<\s*any\b/.test(html)) {
    throw new Error(
      `snippet "${name}" contains a degraded any hover; install workspace dependencies and retry`,
    )
  }
}

const out: Record<string, { html: string; code: string }> = {}
for (const [name, code] of Object.entries(snippets)) {
  const html = highlighter.codeToHtml(code, {
    lang: 'ts',
    theme: 'min-dark',
    transformers: [twoslash],
  })
  assertHealthyTypes(name, html)
  out[name] = { html, code: visibleSource(code) }
  console.log(`snippet ok: ${name}`)
}

await Bun.write(outFile, JSON.stringify(out, null, 2))
console.log(`code-snippets: ${Object.keys(out).length} focused stories`)
