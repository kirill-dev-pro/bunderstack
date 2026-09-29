#!/usr/bin/env bun
// Runs examples/workers-probe as a real Worker and checks each feature end to
// end. Not part of `bun run test`: it starts sqld and a runtime process.
//
//   bun run test:workers                    # celld (CELLD_BIN or `celld`)
//   bun run test:workers -- --runtime workerd  # workerd through wrangler dev
//
// Binaries: SQLD_BIN (default `sqld`), CELLD_BIN (default `celld`).
import type { Subprocess } from 'bun'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repo = join(import.meta.dir, '..')
const probe = join(repo, 'examples/workers-probe')
const runtime = process.argv.includes('--runtime')
  ? process.argv[process.argv.indexOf('--runtime') + 1]
  : 'celld'
if (runtime !== 'celld' && runtime !== 'workerd') {
  throw new Error(`unknown runtime: ${runtime}`)
}

const AUTH_SECRET = 'workers-integration-secret-0123456789abcdef'
const processes: Subprocess[] = []
const cleanups: (() => Promise<unknown>)[] = []

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

async function waitFor(
  what: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check().catch(() => false)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(250)
  }
}

function spawn(cmd: string[], env: Record<string, string> = {}, cwd = repo) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  processes.push(child)
  const log: string[] = []
  const sink = process.env.WORKERS_LOG
    ? Bun.file(process.env.WORKERS_LOG).writer()
    : undefined
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      log.push(chunk)
      sink?.write(chunk)
      sink?.flush()
    }
  }
  void pump(child.stdout)
  void pump(child.stderr)
  return { child, log }
}

// --- setup -----------------------------------------------------------------

async function setup() {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(repo, 'packages/bunderstack'),
  })
  if (build.exitCode !== 0) throw new Error(build.stderr.toString())

  const dir = await mkdtemp(join(tmpdir(), 'bunderstack-workers-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))

  const dbPort = await freePort()
  const databaseUrl = `http://127.0.0.1:${dbPort}`
  spawn([
    process.env.SQLD_BIN ?? 'sqld',
    '--http-listen-addr',
    `127.0.0.1:${dbPort}`,
    '-d',
    join(dir, 'db'),
  ])
  await waitFor(
    'sqld',
    async () => (await fetch(`${databaseUrl}/health`)).ok,
    20_000,
  )

  // wrangler.json is generated from the committed blueprint, as in `bunderstack dev`.
  const { runWranglerCommand } =
    await import('../packages/bunderstack/src/workers/wrangler')
  await runWranglerCommand({ directory: probe })

  // Migrations run on the host, as Bunderhost does before a deploy.
  const { backend } = await import('../examples/workers-probe/src/bunderstack')
  // Resolve from the probe, so provision and the backend share one instance.
  const { provision } = (await import(
    Bun.resolveSync('bunderstack/provision-schema', probe)
  )) as typeof import('../packages/bunderstack/src/provision-schema')
  const app = await backend.start({
    env: { BUNDERSTACK_DATABASE_URL: databaseUrl, AUTH_SECRET },
  })
  await provision(app, { force: true })
  await app.close()

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const devVars = join(probe, '.dev.vars')
  await writeFile(
    devVars,
    [
      `BUNDERSTACK_DATABASE_URL=${databaseUrl}`,
      `AUTH_SECRET=${AUTH_SECRET}`,
      `APP_URL=${base}`,
    ].join('\n'),
  )
  cleanups.push(() => rm(devVars, { force: true }))

  const server =
    runtime === 'celld'
      ? spawn(
          [
            process.env.CELLD_BIN ?? 'celld',
            'dev',
            probe,
            '--port',
            String(port),
            '--clean',
            '--no-watch',
            // Worker console output; kept in memory and printed on failure.
            '--logs',
          ],
          {
            CELLD_ESBUILD:
              process.env.CELLD_ESBUILD ??
              join(repo, 'node_modules/.bin/esbuild'),
          },
        )
      : spawn(
          [
            'bunx',
            'wrangler@4',
            'dev',
            '--config',
            join(probe, 'wrangler.json'),
            '--port',
            String(port),
            '--ip',
            '127.0.0.1',
          ],
          { WRANGLER_SEND_METRICS: 'false', CI: '1' },
        )
  try {
    await waitFor(
      `${runtime} health`,
      async () => (await fetch(`${base}/api/health`)).ok,
      120_000,
    )
  } catch (error) {
    console.error(server.log.join(''))
    throw error
  }
  return { base, server }
}

// --- scenarios -------------------------------------------------------------

type Ctx = { base: string; cookie: string }

async function json(res: Response) {
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.url}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function events(ctx: Ctx, kind: string) {
  const list = await json(await fetch(`${ctx.base}/api/events?limit=100`))
  return (list.items as { kind: string; detail: string }[]).filter(
    (event) => event.kind === kind,
  )
}

async function createNote(ctx: Ctx, title: string) {
  return json(
    await fetch(`${ctx.base}/api/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ title }),
    }),
  )
}

const scenarios: [string, (ctx: Ctx) => Promise<void>][] = [
  [
    'health',
    async (ctx) => {
      const body = await json(await fetch(`${ctx.base}/api/health`))
      if (body.status !== 'ok') throw new Error(JSON.stringify(body))
    },
  ],
  [
    'static assets and SPA fallback',
    async (ctx) => {
      for (const path of ['/', '/some/spa/route']) {
        const text = await (await fetch(`${ctx.base}${path}`)).text()
        if (!text.includes('workers probe')) {
          throw new Error(`${path}: ${text.slice(0, 200)}`)
        }
      }
    },
  ],
  [
    'auth',
    async (ctx) => {
      const headers = { 'content-type': 'application/json', origin: ctx.base }
      const email = `probe-${crypto.randomUUID()}@test.dev`
      const password = 'probe-password-123'
      await json(
        await fetch(`${ctx.base}/api/auth/sign-up/email`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ email, password, name: 'Probe' }),
        }),
      )
      const signIn = await fetch(`${ctx.base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, password }),
      })
      await json(signIn.clone())
      ctx.cookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ')
      const session = await json(
        await fetch(`${ctx.base}/api/auth/get-session`, {
          headers: { cookie: ctx.cookie },
        }),
      )
      if (session?.user?.email !== email) {
        throw new Error(`no session: ${JSON.stringify(session)}`)
      }
    },
  ],
  [
    'crud',
    async (ctx) => {
      const note = await createNote(ctx, 'from the probe')
      const list = await json(
        await fetch(`${ctx.base}/api/notes`, {
          headers: { cookie: ctx.cookie },
        }),
      )
      if (!list.items.some((n: { id: string }) => n.id === note.id)) {
        throw new Error('created note is not listed')
      }
    },
  ],
  [
    'job via notify',
    async (ctx) => {
      const noteId = crypto.randomUUID()
      await json(
        await fetch(`${ctx.base}/api/probe/enqueue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ noteId }),
        }),
      )
      await waitFor(
        'job event',
        async () => (await events(ctx, 'job')).some((e) => e.detail === noteId),
        15_000,
      )
    },
  ],
  [
    'file upload (proxy mode)',
    async (ctx) => {
      const form = new FormData()
      form.set(
        'file',
        new File(['hello r2'], 'hello.txt', { type: 'text/plain' }),
      )
      const uploaded = await json(
        await fetch(`${ctx.base}/api/files/media`, {
          method: 'POST',
          headers: { cookie: ctx.cookie },
          body: form,
        }),
      )
      const res = await fetch(`${ctx.base}${uploaded.url}`, {
        headers: { cookie: ctx.cookie },
      })
      const text = await res.text()
      if (text !== 'hello r2') throw new Error(`${res.status}: ${text}`)
    },
  ],
  [
    'sse via hub, across the 60 s idle limit',
    async (ctx) => {
      const controller = new AbortController()
      const res = await fetch(`${ctx.base}/api/live/notes`, {
        headers: { cookie: ctx.cookie, accept: 'text/event-stream' },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`live: ${res.status}`)
      let seen = ''
      const reading = (async () => {
        for await (const chunk of res.body!.pipeThrough(
          new TextDecoderStream(),
        )) {
          seen += chunk
        }
      })().catch(() => {})
      await Bun.sleep(1_000)
      await createNote(ctx, 'live-early')
      await waitFor(
        'early live event',
        async () => seen.includes('live-early'),
        10_000,
      )
      // The cron scenario runs meanwhile; wait past celld's 60 s stream limit.
      await Bun.sleep(70_000)
      await createNote(ctx, 'live-late')
      await waitFor(
        'late live event',
        async () => seen.includes('live-late'),
        10_000,
      )
      controller.abort()
      await reading
    },
  ],
  [
    'cron via trigger or alarm',
    async (ctx) => {
      await waitFor(
        'cron event',
        async () => (await events(ctx, 'cron')).length > 0,
        90_000,
      )
    },
  ],
]

// --- main ------------------------------------------------------------------

let failed = 0
try {
  const { base, server } = await setup()
  if (process.env.WORKERS_KEEP) {
    // Debug aid: keep sqld and the runtime up for manual requests.
    console.log(`ready at ${base}; Ctrl+C stops`)
    await new Promise<void>((resolve) => process.once('SIGINT', resolve))
    throw new Error('stopped by hand')
  }
  const ctx: Ctx = { base, cookie: '' }
  const run = async ([name, scenario]: (typeof scenarios)[number]) => {
    const started = Date.now()
    try {
      await scenario(ctx)
      console.log(`PASS ${name} (${Date.now() - started} ms)`)
    } catch (error) {
      failed++
      console.log(
        `FAIL ${name}: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  // The first six build on each other; the two slow ones run together.
  for (const scenario of scenarios.slice(0, 6)) await run(scenario)
  await Promise.all(scenarios.slice(6).map(run))
  if (failed > 0)
    console.error(`\n--- ${runtime} log ---\n${server.log.join('')}`)
} catch (error) {
  failed++
  console.error(error)
} finally {
  for (const child of processes) child.kill()
  await Promise.allSettled(processes.map((child) => child.exited))
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
}
console.log(
  failed === 0
    ? `\nall scenarios passed on ${runtime}`
    : `\n${failed} failed on ${runtime}`,
)
process.exit(failed === 0 ? 0 : 1)
