import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const skill = resolve(root, '.agents/skills/creating-bunderstack-apps')
const migrationSkill = resolve(root, '.agents/skills/migrating-to-bunderstack')

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
})

describe('migrating-to-bunderstack skill', () => {
  test('declares a discoverable repository skill', () => {
    const markdown = readFileSync(resolve(migrationSkill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain('name: migrating-to-bunderstack')
    expect(markdown).toContain('description: Use when')
    expect(existsSync(resolve(migrationSkill, 'agents/openai.yaml'))).toBe(true)
  })

  test('migration skill uses current runtime contracts', () => {
    const markdown = readFileSync(resolve(migrationSkill, 'SKILL.md'), 'utf8')
    expect(markdown).toContain(
      "ctx.realtime.publish(schema.tasks, 'update', row)",
    )
    expect(markdown).toContain('createApiHandlers(app)')
    expect(markdown).toContain('app.runWorker()')
    expect(markdown).not.toContain("ctx.realtime.publish('channel', payload)")
    expect(markdown).not.toContain('await app.startWorker()')
  })
})
