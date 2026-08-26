import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { defineTool } from './declaration'
import { agentDefinition } from './definition'

describe('agent declaration', () => {
  test('a declared tool exposes one validated server capability', () => {
    const tool = defineTool({
      id: 'echo',
      version: 1,
      description: 'Echo text.',
      inputSchema: z.object({ text: z.string().min(1) }),
      approval: { mode: 'none' },
      execute: async ({ text }) => ({ text }),
    })

    expect(tool.inputSchema.parse({ text: 'hello' })).toEqual({ text: 'hello' })
    expect(() => tool.inputSchema.parse({ text: '' })).toThrow()
    expect(tool.id).toBe('echo')
    expect(tool.version).toBe(1)
    expect(tool.approval).toEqual({ mode: 'none' })
  })

  test('the app has one local declaration with the existing tools', () => {
    expect(Object.keys(agentDefinition.tools).sort()).toEqual([
      'completeTask',
      'createTask',
      'deleteTask',
      'listTasks',
      'scheduleReminder',
    ])
    expect(agentDefinition.context).toEqual({
      conversation: { recent: 20 },
      inbox: { maxItems: 10 },
      memory: { maxItems: 8 },
    })
  })
})
