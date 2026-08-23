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
const betterAuthDir = dirname(
  Bun.resolveSync(
    'better-auth/package.json',
    join(root, '../packages/bunderstack'),
  ),
)

const APP_FILE = `// @filename: bunderstack.ts
import { createBunderstack } from 'bunderstack'
import { bunSql } from 'bunderstack/database/bun-sql'
import { pgTable, text } from 'drizzle-orm/pg-core'
import * as v from 'valibot'

export const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: bunSql() },
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
import { createAuthClient } from 'better-auth/react'
import type { App } from './bunderstack'

export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })
export const authClient = createAuthClient()
`

const snippets: Record<string, string> = {
  declaration: `// @filename: bunderstack.ts
// ---cut---
import { createBunderstack } from 'bunderstack'
import { bunSql } from 'bunderstack/database/bun-sql'
import { pgTable, text } from 'drizzle-orm/pg-core'
import * as v from 'valibot'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: bunSql() },
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
import { bunSql } from 'bunderstack/database/bun-sql'
import { pgTable, text } from 'drizzle-orm/pg-core'

const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  userId: text('userId').notNull(),
})

export const app = await createBunderstack({
  schema: { posts },
  database: { adapter: bunSql() },
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
import { createAuthClient } from 'better-auth/react'
import type { App } from './bunderstack'

export const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })
export const authClient = createAuthClient()

const result = await api.stats.call()
//    ^?`,

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

  frontend: `${APP_FILE}${CLIENT_FILE}// @filename: Feed.tsx
// ---cut---
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { syncRealtime } from 'bunderstack-query'
import { useEffect, useState } from 'react'
import { api, authClient } from './api-client'

export function Feed() {
  const queryClient = useQueryClient()
  const { data: session } = authClient.useSession()
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const { data: posts } = useQuery(api.posts.list.queryOptions())
  const { data: stats } = useQuery(api.stats.queryOptions())
  const createPost = useMutation(api.posts.create.mutationOptions())

  useEffect(() => {
    const live = syncRealtime({ api, queryClient, tables: ['posts'] })
    return () => live.close()
  }, [queryClient])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (file) await api.files.images.upload(file)
    createPost.mutate({ title })
    setTitle('')
  }

  return (
    <div>
      <header>
        <span>Signed in as {session?.user.name}</span>
        <h2>Posts ({stats?.total ?? 0})</h2>
      </header>

      <form onSubmit={onSubmit}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New post"
        />
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit">Publish</button>
      </form>

      <ul>
        {posts?.items.map((post) => (
        //      ^?
          <li key={post.id}>
            <span>{post.title}</span>
            <img src={api.files.images.url(post.id, { w: 32, h: 32 })} />
          </li>
        ))}
      </ul>
    </div>
  )
}`,
}

const highlighter = await createHighlighter({
  themes: ['min-dark', 'min-light'],
  langs: ['ts', 'tsx'],
})

import { createTwoslasher } from 'twoslash'

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: 'react',
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
    'better-auth': [betterAuthDir],
    'better-auth/*': [join(betterAuthDir, '*')],
    'better-auth/react': [
      join(betterAuthDir, 'dist/client/react/index.d.mts'),
    ],
  },
}

const baseTwoslasher = createTwoslasher({
  compilerOptions,
})

const ALLOWED_HOVER_TOKENS: Record<string, Set<string>> = {
  declaration: new Set(['app', 'context', 'ctx']),
  procedure: new Set(['app', 'context']),
  client: new Set(['result', 'total', 'requestedBy']),
  realtime: new Set(['connection']),
  frontend: new Set(['session', 'posts', 'stats', 'createPost', 'post']),
}

let activeSnippet = ''

function focusedTwoslasher(code: string, lang?: string, options?: any) {
  const res = baseTwoslasher(code, lang, options)
  const allowed = ALLOWED_HOVER_TOKENS[activeSnippet]
  if (allowed) {
    res.nodes = res.nodes.filter((node) => {
      if (node.type !== 'hover') return true
      return allowed.has(node.target)
    })
  }
  return res
}

const twoslash = transformerTwoslash({
  // `^?` queries render on their own line so the popup takes real layout
  // space instead of covering the code beneath it.
  rendererRich: { queryRendering: 'line' },
  twoslasher: focusedTwoslasher,
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

const conceptSnippets: Record<string, string> = {
  database: `schema: { posts },
database: { adapter: bunSql() }`,
  auth: `auth: {
  secret: process.env.AUTH_SECRET!
}`,
  crud: `access: {
  posts: { ownerColumn: 'userId' }
}`,
  api: `api: (o) => ({
  stats: o.protected.handler(async ({ context }) => ({
    total: 12,
    requestedBy: context.user.id,
  })),
})`,
  storage: `storage: {
  local: true,
  buckets: { images: { transforms: true } }
}`,
  email: `email: {
  from: 'hello@example.com'
}`,
  realtime: `realtime: true`,
  jobs: `jobs: (j) =>
  j.define({
    digest: j.cron({
      schedule: '0 9 * * *',
      handler: async (_run, ctx) => {
        await ctx.email.send({ ... })
      },
    }),
  })`,
}

const out: Record<string, any> = {}
for (const [name, code] of Object.entries(snippets)) {
  activeSnippet = name
  const lang = name === 'frontend' ? 'tsx' : 'ts'
  const html = highlighter.codeToHtml(code, {
    lang,
    themes: {
      dark: 'min-dark',
      light: 'min-light',
    },
    defaultColor: false,
    transformers: [twoslash],
  })
  assertHealthyTypes(name, html)
  out[name] = { html, code: visibleSource(code) }
  console.log(`snippet ok: ${name}`)
}

const conceptsOut: Record<string, string> = {}
for (const [id, code] of Object.entries(conceptSnippets)) {
  conceptsOut[id] = highlighter.codeToHtml(code, {
    lang: 'ts',
    themes: {
      dark: 'min-dark',
      light: 'min-light',
    },
    defaultColor: false,
  })
}
out.concepts = conceptsOut

await Bun.write(outFile, JSON.stringify(out, null, 2))
console.log(`code-snippets: ${Object.keys(out).length} stories & concepts generated`)
