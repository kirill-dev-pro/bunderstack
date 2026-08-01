#!/usr/bin/env bun
import {
  BlueprintCheckError,
  generateBlueprint,
  type GenerateBlueprintOptions,
} from './blueprint-generator'

export type CliIo = {
  stdout(message: string): void
  stderr(message: string): void
}

const help = `Usage: bunderstack blueprint [directory] [--entry <path>] [--output <path>] [--check]

Generate a committed deployment declaration for a TanStack Start application.
Entry precedence: --entry, package.json#bunderstack.entry, src/bunderstack.ts.`

export async function runCli(
  args: string[],
  io: CliIo,
  generate: typeof generateBlueprint = generateBlueprint,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') {
    io.stdout(help)
    return 0
  }
  if (args[0] === '--version') {
    io.stdout((await Bun.file(new URL('../package.json', import.meta.url)).json() as { version: string }).version)
    return 0
  }
  if (args[0] !== 'blueprint') {
    io.stderr('Usage: bunderstack blueprint [directory] [--entry <path>] [--output <path>] [--check]')
    return 2
  }
  const options: GenerateBlueprintOptions = { directory: process.cwd() }
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!
    if (argument === '--check') {
      options.check = true
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
      options.check || !result.changed
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
