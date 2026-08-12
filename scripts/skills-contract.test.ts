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
    expect(markdown).toContain('api: (o) =>')
    expect(markdown).toContain('realtime.changes')
    expect(markdown).toContain('heartbeat')
    expect(markdown).not.toContain("ctx.realtime.publish('channel', payload)")
    expect(markdown).not.toContain('await app.startWorker()')
    expect(markdown).not.toContain('protected tRPC')
    expect(markdown).not.toContain('trpc: createAppRouter')
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
