/**
 * Proves what a consumer's TypeScript sees.
 *
 * Packs the four packages exactly as publishing would (`workspace:*` rewritten
 * to the concrete version, `prepack` building `dist`), installs the tarballs
 * into a throwaway app, and typechecks that app under the strictest flags we
 * expect in the wild — with `skipLibCheck` OFF, so our declarations are checked
 * too. The assertion is that no diagnostic points inside `node_modules`: while
 * the packages shipped raw `src`, `exactOptionalPropertyTypes` alone produced
 * 168 of them.
 *
 * Usage: bun scripts/verify-consumer.ts [--keep]
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname
const PACKAGES = [
  'bunderstack',
  'bunderstack-query',
  'bunderstack-sync',
  'bunderstack-start',
] as const

async function run(
  cmd: string[],
  cwd: string,
): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, out: out + err }
}

const workDir = await mkdtemp(join(tmpdir(), 'bunderstack-consumer-'))
const keep = process.argv.includes('--keep')
console.log(`workdir ${workDir}`)

const version = (
  (await Bun.file(join(repoRoot, 'packages/bunderstack/package.json')).json()) as {
    version: string
  }
).version

// Pack with the same manifest rewrite the publish script performs.
const tarballs: Record<string, string> = {}
for (const name of PACKAGES) {
  const dir = join(repoRoot, 'packages', name)
  const manifest = join(dir, 'package.json')
  const original = await Bun.file(manifest).text()
  const sanitized = original.replace(/"workspace:\*"/g, `"^${version}"`)
  if (sanitized !== original) await Bun.write(manifest, sanitized)
  try {
    const packed = await run(
      ['npm', 'pack', '--pack-destination', workDir, '--silent'],
      dir,
    )
    if (packed.code !== 0) throw new Error(`npm pack failed for ${name}:\n${packed.out}`)
    // npm names the tarball deterministically; parsing its stdout would also
    // pick up whatever `prepack` printed.
    const tarball = join(workDir, `${name}-${version}.tgz`)
    if (!(await Bun.file(tarball).exists())) {
      throw new Error(`expected ${tarball} after packing ${name}`)
    }
    tarballs[name] = tarball
  } finally {
    if (sanitized !== original) await Bun.write(manifest, original)
  }
}

const app = join(workDir, 'app')
await mkdir(join(app, 'src'), { recursive: true })

const overrides = Object.fromEntries(
  PACKAGES.map((name) => [name, `file:${tarballs[name]}`]),
)

await writeFile(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'strict-consumer',
      private: true,
      type: 'module',
      dependencies: {
        ...overrides,
        '@libsql/client': '>=0.14.0',
        '@orpc/bun': '2.0.0-beta.26',
        '@orpc/client': '2.0.0-beta.26',
        '@orpc/json-schema': '2.0.0-beta.26',
        '@orpc/openapi': '2.0.0-beta.26',
        '@orpc/publisher': '2.0.0-beta.26',
        '@orpc/server': '2.0.0-beta.26',
        '@orpc/tanstack-query': '2.0.0-beta.26',
        '@orpc/valibot': '2.0.0-beta.26',
        '@tanstack/db': '0.6.16',
        '@tanstack/query-db-collection': '1.1.0',
        '@tanstack/react-query': '^5.101.1',
        'better-auth': '^1.0.0',
        'drizzle-orm': '^0.45.0',
        'drizzle-valibot': '0.4.2',
        react: '^19.0.0',
        valibot: '1.4.2',
      },
      devDependencies: {
        '@types/bun': '^1.3.14',
        '@types/react': '^19.0.0',
        typescript: '^7.0.1-rc',
      },
      // The tarballs depend on each other by version; point those at the
      // tarballs too, since this version is not on the registry yet.
      overrides,
    },
    null,
    2,
  ),
)

await writeFile(
  join(app, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        lib: ['ESNext', 'DOM'],
        target: 'ESNext',
        module: 'Preserve',
        moduleResolution: 'bundler',
        moduleDetection: 'force',
        jsx: 'react-jsx',
        types: ['bun'],
        noEmit: true,
        strict: true,
        // The flags that used to surface library internals as app errors.
        skipLibCheck: false,
        exactOptionalPropertyTypes: true,
        noPropertyAccessFromIndexSignature: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitReturns: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        verbatimModuleSyntax: true,
      },
      include: ['src'],
    },
    null,
    2,
  ),
)

await writeFile(
  join(app, 'src/schema.ts'),
  `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  token: text('token').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
})

export const creditBalances = sqliteTable('credit_balances', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  amount: integer('amount').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
`,
)

await writeFile(
  join(app, 'src/app.ts'),
  `import { createBunderstack, type ApiContext } from 'bunderstack'
import { libsql } from 'bunderstack/database/libsql'
import { generate } from 'bunderstack/typeid'
import { os } from '@orpc/server'
import * as v from 'valibot'

import * as schema from './schema'

// Shared middleware over the real app context — needs ApiContext exported.
const timing = os
  .$context<ApiContext<typeof schema>>()
  .middleware(async ({ next }) => next())

export const app = await createBunderstack({
  schema,
  database: { adapter: libsql(), url: ':memory:' },
  auth: {},
  realtime: true,
  access: {
    creditBalances: {
      crud: true,
      list: 'public',
      get: 'public',
      filterableColumns: ['userId', 'amount', 'createdAt'],
      sortableColumns: ['id', 'amount'],
    },
  },
  api: (o) => ({
    ping: o.public
      .use(timing)
      .input(v.optional(v.object({})))
      .output(v.object({ id: v.string() }))
      .handler(() => ({ id: generate('req') })),
  }),
})

export type App = typeof app
`,
)

await writeFile(
  join(app, 'src/client.ts'),
  `import { createClient } from 'bunderstack-query'
import { createSyncClient } from 'bunderstack-sync'
import { QueryClient } from '@tanstack/react-query'

import type { App } from './app'

const queryClient = new QueryClient()
export const api = createClient<App>({ queryClient })

// Typed nested filters, the beta.2 list contract.
export const listOptions = api.creditBalances.list.queryOptions({
  input: { filters: { userId: 'u1', amount: [1, 2] }, sort: 'amount', limit: 10 },
})

export const invalidateKey = api.creditBalances.list.key({
  input: { filters: { userId: 'u1' } },
})

export const sync = createSyncClient<App>({ queryClient })
export const feed = sync.creditBalances.scopedCollection({
  filters: { userId: 'u1' },
})

export async function realtime(): Promise<void> {
  await sync.realtime?.subscribe(['creditBalances'])
}
`,
)

const install = await run(['bun', 'install'], app)
if (install.code !== 0) throw new Error(`install failed:\n${install.out}`)

const tsc = await run(['bunx', 'tsc', '--noEmit'], app)
const diagnostics = tsc.out
  .split('\n')
  .filter((line) => /error TS\d+/.test(line))
// Our declarations are the contract under test. Other vendors' `.d.ts` files
// are noise here — nobody typechecks node_modules without `skipLibCheck`, and
// drizzle-orm alone reports dozens for its mysql/gel drivers.
const fromBunderstack = diagnostics.filter((line) =>
  /node_modules\/bunderstack(-query|-sync|-start)?\//.test(line),
)
const fromOtherVendors = diagnostics.filter(
  (line) => line.includes('node_modules') && !fromBunderstack.includes(line),
)
const fromApp = diagnostics.filter((line) => !line.includes('node_modules'))

console.log(`\ndiagnostics: ${diagnostics.length}`)
console.log(`  from bunderstack packages: ${fromBunderstack.length}`)
console.log(`  from other vendors:        ${fromOtherVendors.length} (not ours; suppressed by skipLibCheck)`)
console.log(`  from app code:             ${fromApp.length}`)
for (const line of [...fromBunderstack, ...fromApp].slice(0, 30)) {
  console.log(`  ${line}`)
}

const smoke = await run(
  [
    'bun',
    '-e',
    "const m = await import('./src/app.ts'); console.log('handler:' + typeof m.app.handler)",
  ],
  app,
)
const smokeLine = smoke.out
  .split('\n')
  .find((line) => line.startsWith('handler:'))
console.log(`\nruntime smoke: ${smokeLine ?? smoke.out.trim()}`)

if (!keep) await rm(workDir, { recursive: true, force: true })

if (
  fromBunderstack.length > 0 ||
  fromApp.length > 0 ||
  smokeLine !== 'handler:function'
) {
  throw new Error('consumer verification failed')
}
console.log('\nconsumer sees zero errors from bunderstack')
