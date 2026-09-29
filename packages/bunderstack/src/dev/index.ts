// `bunderstack dev` and `bunderstack build`. dev starts sqld and Vite, which
// runs the Worker (SSR, /api, Durable Objects) in workerd through the
// Cloudflare plugin; build checks bunderstack.blueprint.yaml, writes
// wrangler.json from it, and builds dist/server and dist/client with Vite.
import { watch } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateBlueprint } from '../blueprint-generator'
import { runWranglerCommand } from '../workers/wrangler'
import { resolveBinary } from './binaries'
import { devSecret, devVars, readUserEnv } from './env'
import { ProcessGroup, type ProcessSpec } from './processes'

export type DevPlan = {
  appUrl: string
  databaseUrl: string
  sqld?: ProcessSpec
  vite: ProcessSpec
}

export function planDev(input: {
  directory: string
  stateDir: string
  userEnv: Record<string, string>
  ports: { app: number; db: number }
  binaries: { sqld: string }
}): DevPlan {
  const { directory, ports, binaries } = input
  const external = input.userEnv.BUNDERSTACK_DATABASE_URL
  const databaseUrl = external || `http://127.0.0.1:${ports.db}`
  return {
    // localhost, not 127.0.0.1: auth checks the Origin against APP_URL.
    appUrl: `http://localhost:${ports.app}`,
    databaseUrl,
    sqld: external
      ? undefined
      : {
          name: 'sqld',
          cmd: [
            binaries.sqld,
            '--http-listen-addr',
            `127.0.0.1:${ports.db}`,
            '-d',
            join(input.stateDir, 'db'),
          ],
          cwd: directory,
        },
    vite: {
      name: 'vite',
      cmd: [
        process.execPath,
        'x',
        '--bun',
        'vite',
        '--port',
        String(ports.app),
        '--strictPort',
      ],
      cwd: directory,
    },
  }
}

/**
 * Removes what a host must not deploy: the Cloudflare plugin's
 * `.assetsignore` (celld rejects it) and every `.dev.vars` (the plugin copies
 * the local one into dist/server). Returns the removed paths.
 */
export async function cleanArtifact(directory: string): Promise<string[]> {
  const dist = join(directory, 'dist')
  const entries = await readdir(dist, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => [])
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const rel = relative(directory, path).split(sep).join('/')
    if (entry.name === '.dev.vars' || rel === 'dist/client/.assetsignore') {
      await rm(path, { force: true })
      removed.push(rel)
    }
  }
  return removed
}

async function hasViteConfig(directory: string) {
  const files = await readdir(directory)
  return files.some((file) => /^vite\.config\.[cm]?[jt]s$/.test(file))
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolvePort(address.port)
          : reject(new Error('no free port')),
      )
    })
  })
}

function canListen(port: number, hostname: string): boolean {
  try {
    Bun.listen({ hostname, port, socket: { data() {} } }).stop(true)
    return true
  } catch (error) {
    // No IPv6 on this machine: nothing can take the port there either.
    return (error as { code?: string }).code === 'EADDRNOTAVAIL'
  }
}

/**
 * The first port from `start` that is free on 127.0.0.1 and on ::1. The
 * browser opens `localhost`, which can resolve to either; Vite on ::1 next to
 * another server on 127.0.0.1 would answer only some requests.
 */
export async function firstFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    if (canListen(port, '127.0.0.1') && canListen(port, '::1')) return port
  }
  throw new Error(`[bunderstack] no free port from ${start}`)
}

async function waitForHealth(
  url: string,
  timeoutMs: number,
  cancelled: () => boolean,
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cancelled()) return
    const ok = await fetch(url).then(
      (res) => res.ok,
      () => false,
    )
    if (ok) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`)
    await Bun.sleep(200)
  }
}

const pushScript = fileURLToPath(
  new URL(
    import.meta.url.endsWith('.ts') ? './push.ts' : './push.js',
    import.meta.url,
  ),
)

export async function runDev(options: {
  directory: string
  port?: number
}): Promise<number> {
  const directory = resolve(options.directory)
  const stateDir = join(directory, '.bunderstack', 'dev')
  const group = new ProcessGroup()
  const say = (line: string) => group.log('dev', line)

  const userEnv = await readUserEnv(directory)
  const external = Boolean(userEnv.BUNDERSTACK_DATABASE_URL)
  if (!(await hasViteConfig(directory))) {
    say('vite.config.ts is missing; add bunderstack() to it')
    return 1
  }
  const sqld = external ? '' : await resolveBinary('sqld', { log: say })
  const plan = planDev({
    directory,
    stateDir,
    userEnv,
    ports: {
      // An explicit port is kept, and Vite fails when it is taken.
      app:
        options.port ??
        (process.env.PORT
          ? Number(process.env.PORT)
          : await firstFreePort(5173)),
      db: await freePort(),
    },
    binaries: { sqld },
  })

  // Children run in their own process groups, so the terminal's Ctrl+C does
  // not reach them; group.stop() passes it on.
  let interrupted = false
  const interrupt = new Promise<void>((resolveInterrupt) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        interrupted = true
        resolveInterrupt()
      })
    }
  })
  const cancelled = () => interrupted
  let watcher: ReturnType<typeof watch> | undefined

  try {
    await mkdir(stateDir, { recursive: true })
    if (plan.sqld) {
      group.start(plan.sqld)
      await waitForHealth(`${plan.databaseUrl}/health`, 20_000, cancelled)
    }
    const authSecret = await devSecret(stateDir)
    await writeFile(
      join(directory, '.dev.vars'),
      devVars({
        userEnv,
        databaseUrl: plan.databaseUrl,
        appUrl: plan.appUrl,
        authSecret,
      }),
    )
    const pushEnv = {
      ...userEnv,
      BUNDERSTACK_DATABASE_URL: plan.databaseUrl,
      AUTH_SECRET: userEnv.AUTH_SECRET || authSecret,
      APP_URL: plan.appUrl,
    }
    const push = async () => {
      const child = Bun.spawn([process.execPath, pushScript, directory], {
        cwd: directory,
        env: { ...process.env, ...pushEnv },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      // drizzle-kit draws a spinner with escape codes; keep the text only.
      // oxlint-disable-next-line no-control-regex
      const text = `${out}${err}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      for (const line of text.trim().split('\n')) {
        if (line.trim()) group.log('push', line.trim())
      }
      if (code !== 0) group.log('push', 'failed; fix the code and save again')
      return code === 0
    }
    // The first push writes the blueprint and wrangler.json, which the
    // Cloudflare plugin in Vite reads at start.
    await push()

    let timer: ReturnType<typeof setTimeout> | undefined
    let running = Promise.resolve(true)
    watcher = watch(join(directory, 'src'), { recursive: true }, (_, file) => {
      if (file && String(file).endsWith('routeTree.gen.ts')) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        running = running.then(push)
      }, 300)
    })

    if (!interrupted) group.start(plan.vite)
    await waitForHealth(`${plan.appUrl}/api/health`, 60_000, cancelled).catch(
      () => say('the Worker did not answer /api/health yet; see the vite log'),
    )
    if (!interrupted) say(`App: ${plan.appUrl}`)

    const outcome = await Promise.race([group.exited, interrupt])
    if (outcome && !interrupted) {
      say(`${outcome.name} exited with code ${outcome.code}; stopping`)
      return 1
    }
    return 0
  } catch (error) {
    say(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    watcher?.close()
    await group.stop()
  }
}

export async function runBuild(options: {
  directory: string
}): Promise<number> {
  const directory = resolve(options.directory)
  try {
    await generateBlueprint({ directory, check: true })
    console.log('bunderstack.blueprint.yaml is current')
    await runWranglerCommand({ directory })
    console.log('wrote wrangler.json')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  if (!(await hasViteConfig(directory))) {
    console.error(
      '[bunderstack] vite.config.ts is missing; add bunderstack() to it',
    )
    return 1
  }
  const vite = Bun.spawn([process.execPath, 'x', '--bun', 'vite', 'build'], {
    cwd: directory,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await vite.exited) !== 0) return 1
  for (const path of await cleanArtifact(directory)) {
    console.log(`removed ${path}`)
  }
  if (!(await Bun.file(join(directory, 'dist/server/index.js')).exists())) {
    console.error(
      '[bunderstack] the build did not produce dist/server/index.js',
    )
    return 1
  }
  return 0
}
