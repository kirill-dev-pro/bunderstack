import { describe, expect, mock, test } from 'bun:test'

import type { AgentResponderInput, AgentTools } from './types'

import {
  createAIResponder,
  createDemoResponder,
  createModelTools,
  createOpenAIResponder,
} from './model'

function input(
  latestMessage: string,
  overrides: Partial<AgentResponderInput> = {},
) {
  const tools: AgentTools = {
    listTasks: mock(async () => []),
    createTask: mock(async ({ title }) => ({
      id: 'task_1',
      title,
      done: false,
    })),
    completeTask: mock(async ({ taskId }) => ({
      id: taskId,
      title: 'Book flights',
      done: true,
    })),
    scheduleReminder: mock(async ({ title, dueAt }) => ({
      id: 'commitment_1',
      title,
      dueAt,
    })),
  }
  return {
    value: {
      reason: 'message',
      now: new Date('2026-08-24T10:00:00.000Z'),
      latestMessage,
      messages: [{ role: 'user' as const, content: latestMessage }],
      tasks: [],
      tools,
      ...overrides,
    },
    tools,
  }
}

describe('demo responder', () => {
  test('turns an add request into a createTask tool call', async () => {
    const { value, tools } = input('Add book flights')

    const response = await createDemoResponder()(value)

    expect(response.text).toBe('Added “book flights”.')
    expect(tools.createTask).toHaveBeenCalledWith({ title: 'book flights' })
  })

  test('schedules a relative reminder from the injected clock', async () => {
    const { value, tools } = input('Remind me in 15 minutes to check the oven')

    const response = await createDemoResponder()(value)

    expect(response.text).toBe(
      'I’ll remind you to “check the oven” in 15 minutes.',
    )
    expect(tools.scheduleReminder).toHaveBeenCalledWith({
      title: 'check the oven',
      dueAt: new Date('2026-08-24T10:15:00.000Z'),
    })
  })

  test('completes a task by matching its title', async () => {
    const { value, tools } = input('Complete book flights', {
      tasks: [{ id: 'task_1', title: 'Book flights', done: false }],
    })

    const response = await createDemoResponder()(value)

    expect(response.text).toBe('Completed “Book flights”.')
    expect(tools.completeTask).toHaveBeenCalledWith({ taskId: 'task_1' })
  })
})

describe('AI responder factory', () => {
  test('builds the model tool set from the app-local agent declaration', () => {
    const { value } = input('List tasks')

    expect(Object.keys(createModelTools(value)).sort()).toEqual([
      'completeTask',
      'createTask',
      'listTasks',
      'scheduleReminder',
    ])
  })

  test('creates a responder function with default Hetzner configuration', () => {
    const responder = createAIResponder({ apiKey: 'test-token' })
    expect(typeof responder).toBe('function')
  })

  test('creates a responder function with custom baseURL and model', () => {
    const responder = createAIResponder({
      apiKey: 'test-key',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    })
    expect(typeof responder).toBe('function')
  })

  test('createOpenAIResponder is compatible alias', () => {
    const responder = createOpenAIResponder({
      apiKey: 'test-key',
      model: 'gpt-5-mini',
    })
    expect(typeof responder).toBe('function')
  })
})
