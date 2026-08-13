import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The skills this package ships, copied from `.agents/skills` at build time. */
export const SHIPPED_SKILLS = [
  'creating-bunderstack-apps',
  'migrating-to-bunderstack',
] as const

const MARKER_START = '<!-- bunderstack:skills -->'
const MARKER_END = '<!-- /bunderstack:skills -->'

/**
 * Agents read AGENTS.md before they search for anything, so the pointer is
 * what actually gets the skills into context. The markers let a later
 * `bunderstack skills` run replace the block without touching the rest.
 */
function agentsBlock(directory: string): string {
  return `${MARKER_START}
## Bunderstack

This project uses Bunderstack. Before changing the server API, access rules,
jobs, storage, or realtime, read \`${directory}/creating-bunderstack-apps/SKILL.md\`.
When replacing existing infrastructure, read
\`${directory}/migrating-to-bunderstack/SKILL.md\` instead.

\`node_modules/bunderstack/llms.txt\` is a dense plain-text reference for the
whole framework.
${MARKER_END}`
}

export type SkillsOptions = {
  /** Project root the skills are installed into. */
  cwd: string
  /** Destination, relative to `cwd`. */
  directory?: string
  /** Report drift instead of writing. Exits non-zero when anything differs. */
  check?: boolean
}

export type SkillsIo = {
  stdout(message: string): void
  stderr(message: string): void
}

/** Where this build keeps its copy of the skills. */
function packagedSkillsDir(): string {
  return join(new URL('..', import.meta.url).pathname, 'skills')
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

async function differs(from: string, to: string): Promise<boolean> {
  if (!existsSync(to)) return true
  const sources = await filesUnder(from)
  for (const source of sources) {
    const target = join(to, source.slice(from.length + 1))
    if (!existsSync(target)) return true
    if ((await readFile(source, 'utf8')) !== (await readFile(target, 'utf8'))) {
      return true
    }
  }
  return false
}

async function writeAgentsPointer(
  cwd: string,
  directory: string,
): Promise<'created' | 'updated' | 'current'> {
  const path = join(cwd, 'AGENTS.md')
  const block = agentsBlock(directory)

  if (!existsSync(path)) {
    await writeFile(path, `# Agent guide\n\n${block}\n`)
    return 'created'
  }

  const current = await readFile(path, 'utf8')
  const start = current.indexOf(MARKER_START)
  const end = current.indexOf(MARKER_END)

  if (start !== -1 && end !== -1) {
    const replaced =
      current.slice(0, start) + block + current.slice(end + MARKER_END.length)
    if (replaced === current) return 'current'
    await writeFile(path, replaced)
    return 'updated'
  }

  await writeFile(path, `${current.trimEnd()}\n\n${block}\n`)
  return 'updated'
}

export async function installSkills(
  options: SkillsOptions,
  io: SkillsIo,
): Promise<number> {
  const source = packagedSkillsDir()
  if (!existsSync(source)) {
    io.stderr(
      '[bunderstack] this build ships no skills; reinstall the package or run bun run build',
    )
    return 1
  }

  const directory = options.directory ?? '.agents/skills'
  const destination = join(options.cwd, directory)
  const stale: string[] = []

  for (const skill of SHIPPED_SKILLS) {
    const from = join(source, skill)
    const to = join(destination, skill)
    if (!(await differs(from, to))) continue
    stale.push(skill)
    if (options.check) continue
    await mkdir(destination, { recursive: true })
    await cp(from, to, { recursive: true })
  }

  if (options.check) {
    const pointer = await readFile(join(options.cwd, 'AGENTS.md'), 'utf8').catch(
      () => '',
    )
    const pointerStale = !pointer.includes(MARKER_START)
    if (stale.length === 0 && !pointerStale) {
      io.stdout(`${directory} is current`)
      return 0
    }
    for (const skill of stale) {
      io.stderr(`[bunderstack] ${directory}/${skill} is missing or outdated`)
    }
    if (pointerStale) io.stderr('[bunderstack] AGENTS.md has no Bunderstack block')
    io.stderr('[bunderstack] run: bunx bunderstack skills')
    return 1
  }

  const pointer = await writeAgentsPointer(options.cwd, directory)

  io.stdout(
    stale.length === 0
      ? `${directory} is current`
      : `Installed ${stale.length} skill(s) into ${directory}: ${stale.join(', ')}`,
  )
  if (pointer !== 'current') io.stdout(`AGENTS.md ${pointer}`)
  return 0
}
