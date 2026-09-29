#!/usr/bin/env bun
import {
  BlueprintCheckError,
  generateBlueprint,
  type GenerateBlueprintOptions,
} from './blueprint-generator'
import { installSkills } from './cli-skills'

export type CliIo = {
  stdout(message: string): void
  stderr(message: string): void
}

const help = `Usage:
  bunderstack blueprint [directory] [--entry <path>] [--output <path>] [--check|--hosted-check]
  bunderstack skills [--dir <path>] [--check]
  bunderstack wrangler [directory] [--name <name>] [--output <path>]
  bunderstack dev [directory] [--port <port>]
  bunderstack build [directory]

blueprint  Generate bunderstack.blueprint.yaml, the committed deploy contract of a
           Worker application. Entry precedence: --entry,
           package.json#bunderstack.entry, src/bunderstack.ts.

skills     Install the Bunderstack agent skills that match this version into
           .agents/skills, and point AGENTS.md at them so an agent loads them
           before touching the API. --check reports drift without writing.

wrangler   Write wrangler.json, the input config of the Cloudflare Vite plugin, from
           bunderstack.blueprint.yaml. The file is generated; do not commit
           it.

dev        Start the app locally: sqld and Vite, with the Worker (SSR, /api,
           Durable Objects) in workerd. Regenerates bunderstack.blueprint.yaml
           and wrangler.json and pushes the schema on each change under src/.
           Ctrl+C stops everything. BUNDERSTACK_SQLD_BIN selects a system sqld
           instead of the pinned download.

build      Check that bunderstack.blueprint.yaml is current, write
           wrangler.json from it, build the Worker and client with Vite into
           dist/server and dist/client, and remove files hosts must not deploy.`

type AppCommands = {
  dev(options: { directory: string; port?: number }): Promise<number>
  build(options: { directory: string }): Promise<number>
}

const appCommands: AppCommands = {
  dev: async (options) => (await import('./dev/index')).runDev(options),
  build: async (options) => (await import('./dev/index')).runBuild(options),
}

export async function runCli(
  args: string[],
  io: CliIo,
  generate: typeof generateBlueprint = generateBlueprint,
  commands: AppCommands = appCommands,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    io.stdout(help)
    return 0
  }
  if (args[0] === '--version') {
    io.stdout(
      (
        (await Bun.file(
          new URL('../package.json', import.meta.url),
        ).json()) as { version: string }
      ).version,
    )
    return 0
  }
  if (args[0] === 'skills') {
    const options: { cwd: string; directory?: string; check?: boolean } = {
      cwd: process.cwd(),
    }
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!
      if (argument === '--check') {
        options.check = true
        continue
      }
      if (argument === '--dir') {
        const value = args[++index]
        if (!value || value.startsWith('--')) {
          io.stderr('[bunderstack] missing value for --dir')
          return 2
        }
        options.directory = value
        continue
      }
      io.stderr(`[bunderstack] unknown option: ${argument}`)
      return 2
    }
    return installSkills(options, io)
  }

  if (args[0] === 'dev' || args[0] === 'build') {
    const command = args[0]
    let directory: string | undefined
    let port: number | undefined
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!
      if (command === 'dev' && argument === '--port') {
        const value = Number(args[++index])
        if (!Number.isInteger(value) || value <= 0) {
          io.stderr('[bunderstack] --port needs a port number')
          return 2
        }
        port = value
        continue
      }
      if (argument.startsWith('-')) {
        io.stderr(`[bunderstack] unknown option: ${argument}`)
        return 2
      }
      if (directory !== undefined) {
        io.stderr('[bunderstack] only one application directory is allowed')
        return 2
      }
      directory = argument
    }
    directory ??= process.cwd()
    return command === 'dev'
      ? commands.dev({ directory, ...(port ? { port } : {}) })
      : commands.build({ directory })
  }

  if (args[0] === 'wrangler') {
    const options: { directory: string; name?: string; output?: string } = {
      directory: process.cwd(),
    }
    const valued = {
      '--name': 'name',
      '--output': 'output',
    } as const
    let directorySet = false
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!
      if (argument in valued) {
        const value = args[++index]
        if (!value || value.startsWith('--')) {
          io.stderr(`[bunderstack] missing value for ${argument}`)
          return 2
        }
        options[valued[argument as keyof typeof valued]] = value
        continue
      }
      if (argument.startsWith('-')) {
        io.stderr(`[bunderstack] unknown option: ${argument}`)
        return 2
      }
      if (directorySet) {
        io.stderr('[bunderstack] only one application directory is allowed')
        return 2
      }
      options.directory = argument
      directorySet = true
    }
    try {
      const { runWranglerCommand } = await import('./workers/wrangler')
      const result = await runWranglerCommand(options)
      io.stdout(
        result.changed ? 'Generated wrangler.json' : 'wrangler.json is current',
      )
      return 0
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error))
      return 1
    }
  }

  if (args[0] !== 'blueprint') {
    io.stderr(help)
    return 2
  }
  const options: GenerateBlueprintOptions = { directory: process.cwd() }
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--check') {
      if (options.hostedCheck) {
        io.stderr(
          '[bunderstack] --check and --hosted-check are mutually exclusive',
        )
        return 2
      }
      options.check = true
      continue
    }
    if (argument === '--hosted-check') {
      if (options.check) {
        io.stderr(
          '[bunderstack] --check and --hosted-check are mutually exclusive',
        )
        return 2
      }
      options.hostedCheck = true
      continue
    }
    if (argument === '--entry' || argument === '--output') {
      const value = args[++index]
      if (!value || value.startsWith('--')) {
        io.stderr(`[bunderstack] missing value for ${argument}`)
        return 2
      }
      if (argument === '--entry') options.entry = value
      else options.output = value
      continue
    }
    if (argument.startsWith('-')) {
      io.stderr(`[bunderstack] unknown option: ${argument}`)
      return 2
    }
    if (options.directory !== process.cwd()) {
      io.stderr('[bunderstack] only one application directory is allowed')
      return 2
    }
    options.directory = argument
  }
  try {
    const result = await generate(options)
    io.stdout(
      options.check || options.hostedCheck || !result.changed
        ? 'bunderstack.blueprint.yaml is current'
        : 'Generated bunderstack.blueprint.yaml',
    )
    return 0
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return error instanceof BlueprintCheckError ? 1 : 1
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  })
  process.exit(exitCode)
}
