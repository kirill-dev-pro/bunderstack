#!/usr/bin/env bun
import type {
  generateBlueprint,
  GenerateBlueprintOptions,
} from './blueprint-generator'
import type { seedCommand, SeedCommandOptions } from './seed-command'

import { installSkills } from './cli-skills'

export type CliIo = {
  stdout(message: string): void
  stderr(message: string): void
}

const help = `Usage:
  bunderstack blueprint [directory] [--entry <path>] [--output <path>] [--check|--hosted-check]
  bunderstack seed [directory] [--entry <path>] [--reset]
  bunderstack skills [--dir <path>] [--check]

blueprint  Generate a committed deployment declaration for a TanStack Start
           application. Entry precedence: --entry,
           package.json#bunderstack.entry, src/bunderstack.ts. An application
           that declares a seed has it run against a throwaway database
           first, and a seed that fails stops the command.

seed       Run the application's seed (database.seed) against its local
           database, once: a database that is already seeded is left alone.
           --reset empties the application's tables first. Refused for a
           remote database.

skills     Install the Bunderstack agent skills that match this version into
           .agents/skills, and point AGENTS.md at them so an agent loads them
           before touching the API. --check reports drift without writing.`

export async function runCli(
  args: string[],
  io: CliIo,
  generate?: typeof generateBlueprint,
  seed?: typeof seedCommand,
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

  if (args[0] === 'seed') {
    const options: SeedCommandOptions = { directory: process.cwd() }
    for (let index = 1; index < args.length; index++) {
      const argument = args[index]!
      if (argument === '--reset') {
        options.reset = true
        continue
      }
      if (argument === '--entry') {
        const value = args[++index]
        if (!value || value.startsWith('--')) {
          io.stderr('[bunderstack] missing value for --entry')
          return 2
        }
        options.entry = value
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
      const run = seed ?? (await import('./seed-command')).seedCommand
      const result = await run(options)
      if (result.outcome === 'not-declared') {
        io.stderr(
          '[bunderstack] this application declares no seed: add `seed: () => import("./seed")` to `database` in its backend',
        )
        return 1
      }
      if (result.emptied) {
        io.stdout(
          result.emptied.length > 0
            ? `Emptied ${result.emptied.length} table(s): ${result.emptied.join(', ')}`
            : 'No application tables to empty',
        )
      }
      io.stdout(
        result.outcome === 'seeded'
          ? 'Seeded the database'
          : 'The database is already seeded; `bunderstack seed --reset` empties the application’s tables and seeds again',
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
    // Skills must install before an app has any of the backend's optional peers.
    const run =
      generate ?? (await import('./blueprint-generator')).generateBlueprint
    const result = await run(options)
    io.stdout(
      options.check || options.hostedCheck || !result.changed
        ? 'bunderstack.blueprint.yaml is current'
        : 'Generated bunderstack.blueprint.yaml',
    )
    if (result.seedCheck?.status === 'passed') {
      io.stdout('The seed runs against this schema')
    }
    if (result.seedCheck?.status === 'skipped') {
      io.stdout(`The seed was not checked: ${result.seedCheck.reason}`)
    }
    return 0
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  })
  process.exit(exitCode)
}
