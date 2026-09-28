// `bunderstack dev` and `bunderstack build`. dev starts sqld, celld, and Vite
// with one command; build writes the SPA to dist/client and checks
// wrangler.json and bunderstack.blueprint.yaml.
import { watch } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateBlueprint } from '../blueprint-generator'
import { runWranglerCommand } from '../workers/wrangler'
import { resolveBinary } from './binaries'
import { devSecret, devVars, readUserEnv } from './env'
import { ProcessGroup, type ProcessSpec } from './processes'

export type DevPlan = {
  appUrl: string
  apiUrl: string
  databaseUrl: string
  sqld?: ProcessSpec
  worker: ProcessSpec
  vite?: ProcessSpec
}

const LOG_LINE = /^\S+Z\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+): (.*)$/

/**
 * celld --logs mixes the Worker's console output with its own INFO lines.
 * Keep the Worker output (without the timestamp), warnings, errors, and the
 * start summary.
 */
export function celldLine(line: string): string | undefined {
  if (line.startsWith('<jemalloc>')) return undefined
  const match = LOG_LINE.exec(line)
  if (!match) return line
  const [, level, target, message] = match as unknown as [
    string,
    string,
    string,
    string,
  ]
  if (target === 'cell_console') return message
  if (target === 'celld::memory') return undefined // allocator notice on macOS
  if (level === 'WARN' || level === 'ERROR') return `${level} ${message}`
  return undefined
}

export function planDev(input: {
  directory: string
  stateDir: string
  userEnv: Record<string, string>
  hasVite: boolean
  ports: { app: number; api: number; db: number }
  binaries: { celld: string; sqld: string; esbuild: string }
}): DevPlan {
  const { directory, ports, binaries } = input
  const apiUrl = `http://127.0.0.1:${ports.api}`
  const appUrl = input.hasVite ? `http://localhost:${ports.app}` : apiUrl
  const external = input.userEnv.BUNDERSTACK_DATABASE_URL
  const databaseUrl = external || `http://127.0.0.1:${ports.db}`
  return {
    appUrl,
    apiUrl,
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
    worker: {
      name: 'celld',
      cmd: [
        binaries.celld,
        'dev',
        directory,
        '--port',
        String(ports.api),
        // Shows the Worker's console output.
        '--logs',
        // sqld writes here; a rebuild per write would restart the Worker.
        '--watch-ignore',
        '.bunderstack/**',
        '--watch-ignore',
        'dist/**',
      ],
      cwd: directory,
      env: { CELLD_ESBUILD: binaries.esbuild },
      filter: celldLine,
    },
    vite: input.hasVite
      ? {
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
          env: { BUNDERSTACK_DEV_API_URL: apiUrl },
        }
      : undefined,
  }
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

function esbuildBinary() {
  const pkg = Bun.resolveSync('esbuild/package.json', import.meta.dir)
  return join(dirname(pkg), 'bin', 'esbuild')
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
  const [celld, sqld] = await Promise.all([
    resolveBinary('celld', { log: say }),
    external ? '' : resolveBinary('sqld', { log: say }),
  ])
  const plan = planDev({
    directory,
    stateDir,
    userEnv,
    hasVite: await hasViteConfig(directory),
    ports: {
      // An explicit port is kept, and Vite fails when it is taken.
      app:
        options.port ??
        (process.env.PORT
          ? Number(process.env.PORT)
          : await firstFreePort(5173)),
      api: await freePort(),
      db: await freePort(),
    },
    binaries: { celld, sqld, esbuild: esbuildBinary() },
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
    // The first push also writes wrangler.json, which celld reads at start.
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

    group.start(plan.worker)
    await waitForHealth(`${plan.apiUrl}/api/health`, 60_000, cancelled).catch(
      () => say('the Worker did not answer /api/health yet; see the celld log'),
    )
    if (plan.vite && !interrupted) group.start(plan.vite)
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
  if (await hasViteConfig(directory)) {
    const vite = Bun.spawn([process.execPath, 'x', '--bun', 'vite', 'build'], {
      cwd: directory,
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await vite.exited) !== 0) return 1
  }
  try {
    await runWranglerCommand({ directory, check: true })
    console.log('wrangler.json is current')
    await generateBlueprint({ directory, check: true })
    console.log('bunderstack.blueprint.yaml is current')
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
