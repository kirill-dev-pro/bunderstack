/**
 * Builds one workspace package's published `dist`.
 *
 * `tsc` emits JS and declarations file-for-file, so every `exports` entry keeps
 * its own `.js`/`.d.ts` pair and consumers typecheck our declarations instead of
 * our sources. TypeScript leaves relative specifiers exactly as written
 * (extensionless), which only resolves under bundler-style resolution — so this
 * script rewrites them to the real emitted file and then proves every one of
 * them resolves. A dangling specifier fails the build here rather than in
 * someone else's app.
 *
 * Usage: bun scripts/build-package.ts <package-name>
 */
import { existsSync } from 'node:fs'
import { cp, readdir, rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walk(path) : [path]
    }),
  )
  return files.flat()
}

/** `./access` → `./access.js`, `./jobs` → `./jobs/index.js`. */
async function resolveSpecifier(
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  if (/\.(js|json|css|mjs|cjs)$/.test(specifier)) return null
  const base = join(dirname(fromFile), specifier)
  if (await Bun.file(`${base}.js`).exists()) return `${specifier}.js`
  if (await Bun.file(join(base, 'index.js')).exists()) {
    return `${specifier.replace(/\/$/, '')}/index.js`
  }
  return null
}

const RELATIVE_IMPORT =
  /(\bfrom\s*|\bimport\s*|\bexport\s*\*\s*from\s*|\bimport\()(['"])(\.\.?\/[^'"]*)\2/g

/** A JSDoc example is not an import; only real code may fail the build. */
function isOnCommentLine(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1
  return /^\s*(\*|\/\/|\/\*)/.test(source.slice(lineStart, index))
}

async function rewrite(file: string): Promise<string[]> {
  const source = await Bun.file(file).text()
  const unresolved: string[] = []
  const replacements = new Map<string, string>()

  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[3]!
    if (replacements.has(specifier)) continue
    const resolved = await resolveSpecifier(file, specifier)
    if (resolved) replacements.set(specifier, resolved)
    else if (
      !/\.(js|json|css|mjs|cjs)$/.test(specifier) &&
      !isOnCommentLine(source, match.index)
    ) {
      unresolved.push(specifier)
    }
  }

  if (replacements.size) {
    const next = source.replace(
      RELATIVE_IMPORT,
      (whole, keyword: string, quote: string, specifier: string) => {
        const resolved = replacements.get(specifier)
        return resolved ? `${keyword}${quote}${resolved}${quote}` : whole
      },
    )
    await Bun.write(file, next)
  }

  return unresolved.map((specifier) => `${relative(repoRoot, file)}: ${specifier}`)
}

const name = process.argv[2]
if (!name) throw new Error('usage: bun scripts/build-package.ts <package-name>')

const packageDir = join(repoRoot, 'packages', name)
const distDir = join(packageDir, 'dist')

await rm(distDir, { recursive: true, force: true })

const tsc = Bun.spawn(['bunx', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: packageDir,
  stdout: 'inherit',
  stderr: 'inherit',
})
if ((await tsc.exited) !== 0) throw new Error(`${name}: tsc failed`)

const emitted = (await walk(distDir)).filter((file) =>
  /\.(js|d\.ts)$/.test(file),
)
const problems = (await Promise.all(emitted.map(rewrite))).flat()
if (problems.length) {
  throw new Error(
    `${name}: emitted imports that resolve to nothing:\n  ${problems.join('\n  ')}`,
  )
}

// The agent skills are authored once in .agents/skills, where this repo's own
// agents read them, and shipped from the package so `bunderstack skills` can
// install the pair that matches the installed version.
const SHIPPED_SKILLS = ['creating-bunderstack-apps', 'migrating-to-bunderstack']

if (name === 'bunderstack') {
  const skillsDir = join(packageDir, 'skills')
  await rm(skillsDir, { recursive: true, force: true })
  for (const skill of SHIPPED_SKILLS) {
    const from = join(repoRoot, '.agents/skills', skill)
    if (!existsSync(from)) throw new Error(`${name}: missing skill ${skill}`)
    await cp(from, join(skillsDir, skill), { recursive: true })
  }
  console.log(`packaged skills: ${SHIPPED_SKILLS.join(', ')}`)
}

console.log(`built ${name}: ${emitted.length} files`)
