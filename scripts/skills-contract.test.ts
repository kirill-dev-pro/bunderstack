import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const skill = resolve(root, '.agents/skills/creating-bunderstack-apps')
const migrationSkill = resolve(root, '.agents/skills/migrating-to-bunderstack')

function read(...parts: string[]) {
  return readFileSync(resolve(root, ...parts), 'utf8')
}

describe('creating-bunderstack-apps skill', () => {
  test('declares a discoverable repository skill', () => {
    const markdown = readFileSync(resolve(skill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('name: creating-bunderstack-apps')
    expect(markdown).toContain('description: Use when')
    expect(existsSync(resolve(skill, 'agents/openai.yaml'))).toBe(true)
  })

  test('points full apps to the versioned template without embedding it', () => {
    const markdown = readFileSync(resolve(skill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('templates/tanstack-start-saas')
    expect(existsSync(resolve(skill, 'assets'))).toBe(false)
  })

  test('documents the unified oRPC and realtime contracts', () => {
    const markdown = [
      read('.agents/skills/creating-bunderstack-apps/SKILL.md'),
      read(
        '.agents/skills/creating-bunderstack-apps/references/application-structure.md',
      ),
      read(
        '.agents/skills/creating-bunderstack-apps/references/runtime-integrations.md',
      ),
    ].join('\n')

    expect(markdown).toContain('oRPC')
    expect(markdown).toContain('realtime.changes')
    expect(markdown).toContain('heartbeat')
    expect(markdown).not.toContain('protected tRPC')
    expect(markdown).not.toContain('trpc/')
  })
})

describe('migrating-to-bunderstack skill', () => {
  test('declares a discoverable repository skill', () => {
    const markdown = readFileSync(resolve(migrationSkill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('name: migrating-to-bunderstack')
    expect(markdown).toContain('description: Use when')
    expect(existsSync(resolve(migrationSkill, 'agents/openai.yaml'))).toBe(true)
  })

  test('migration skill uses current runtime contracts', () => {
    const markdown = [
      read('.agents/skills/migrating-to-bunderstack/SKILL.md'),
      read(
        '.agents/skills/migrating-to-bunderstack/references/runtime-replacements.md',
      ),
    ].join('\n')
    expect(markdown).toContain(
      "ctx.realtime.publish(schema.tasks, 'update', row)",
    )
    expect(markdown).toContain('createApiHandlers(app)')
    expect(markdown).toContain('app.runWorker()')
    expect(markdown).toContain('realtime.changes')
    expect(markdown).toContain('heartbeat')
    expect(markdown).not.toContain("ctx.realtime.publish('channel', payload)")
    expect(markdown).not.toContain('await app.startWorker()')
    expect(markdown).not.toContain('protected tRPC')
    expect(markdown).not.toContain('trpc: createAppRouter')
  })

  test('replaces the shapes this API rework retired', () => {
    const markdown = [
      read('.agents/skills/migrating-to-bunderstack/SKILL.md'),
      read(
        '.agents/skills/migrating-to-bunderstack/references/audit-checklist.md',
      ),
      read(
        '.agents/skills/migrating-to-bunderstack/references/runtime-replacements.md',
      ),
    ].join('\n')

    expect(markdown).toContain('defineApi({ schema, env: envSchema })')
    expect(markdown).toContain('middleware: [instrumentation]')
    expect(markdown).toContain('bag of procedures')
    expect(markdown).toContain('errors.CODE({ message })')
    expect(markdown).toContain('BunderstackError')
    expect(markdown).toContain('listSpec(table, options)')
    expect(markdown).toContain('BunderstackDb<typeof schema>')

    // The callback form still exists, but it is no longer the migration target.
    expect(markdown).not.toContain('| `api: (o) => ({ ... })` with one')
  })
})

describe('skills teach the current API declaration', () => {
  test('creating skill declares bases at module scope', () => {
    const markdown = read(
      '.agents/skills/creating-bunderstack-apps/references/application-structure.md',
    )

    expect(markdown).toContain('defineApi({ schema, env: envSchema })')
    expect(markdown).toContain('Do not write a router factory')
    expect(markdown).toContain('o.protected.use(')
    expect(markdown).toContain('errors.FORBIDDEN(')
    expect(markdown).toContain('listSpec(appLogs')
    expect(markdown).toContain('BunderstackDb<typeof schema>')
  })

  test('creating skill states the middleware coverage gap', () => {
    const markdown = read(
      '.agents/skills/creating-bunderstack-apps/references/application-structure.md',
    )

    expect(markdown).toContain('never pass through a base the application')
    expect(markdown).toContain('middleware: [instrumentation]')
    expect(markdown).toContain('context.peekSession()')
    expect(markdown).toContain('never for\nauthorization')
    expect(markdown).toContain('when the stream closes')
  })

  test('creating skill points at the shipped llms.txt', () => {
    const markdown = read('.agents/skills/creating-bunderstack-apps/SKILL.md')
    expect(markdown).toContain('node_modules/bunderstack/llms.txt')
  })
})

test('published docs describe the implemented realtime behavior', () => {
  const readme = read('README.md')
  const design = read(
    'docs/superpowers/specs/2026-08-11-sync-mutation-reconciliation-design.md',
  )

  expect(readme).toContain('heartbeat')
  expect(readme).toContain('without a follow-up list refetch')
  expect(design).toContain('**Status:** Implemented')
})

describe('skills delivery', () => {
  test('the package ships the skills it installs', () => {
    const pkg = JSON.parse(read('packages/bunderstack/package.json')) as {
      files: string[]
    }
    expect(pkg.files).toContain('skills')

    // The canonical copy stays in .agents/skills; the build copies it.
    const build = read('scripts/build-package.ts')
    expect(build).toContain("'creating-bunderstack-apps'")
    expect(build).toContain("'migrating-to-bunderstack'")
    expect(build).toContain('.agents/skills')
  })

  test('the CLI documents and implements the install command', () => {
    const cli = read('packages/bunderstack/src/cli.ts')
    expect(cli).toContain("args[0] === 'skills'")
    expect(cli).toContain('bunderstack skills [--dir <path>] [--check]')
  })

  test('the docs show how to install and how to check', () => {
    const docs = read('website/content/docs/templates-and-skills.mdx')
    expect(docs).toContain('bunx bunderstack skills')
    expect(docs).toContain('bunx bunderstack skills --check')
    expect(docs).toContain('AGENTS.md')
    expect(docs).toContain('node_modules/bunderstack/llms.txt')
  })
})
