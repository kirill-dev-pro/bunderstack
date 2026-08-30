import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'

import type { AgentResponderInput, AgentTools } from './types'

import {
  createAIResponder,
  createDemoResponder,
  createLanguageModelResponder,
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
    createCommitment: mock(async ({ title, dueAt, execution }) => ({
      id: 'commitment_1',
      title,
      dueAt,
      execution,
    })),
    listCommitments: mock(async () => []),
    cancelCommitment: mock(async ({ commitmentId }) => ({ commitmentId })),
    pauseCommitment: mock(async ({ commitmentId }) => ({ commitmentId })),
    resumeCommitment: mock(async ({ commitmentId }) => ({ commitmentId })),
    retryCommitment: mock(async ({ commitmentId }) => ({ commitmentId })),
    deleteTask: mock(async ({ taskId }) => ({
      id: taskId,
      title: 'Book flights',
      done: false,
    })),
    remember: mock(async ({ key, value }) => ({ key, value })),
  }
  return {
    value: {
      reason: 'message',
      now: new Date('2026-08-24T10:00:00.000Z'),
      instructions: 'Test instructions',
      trigger: { type: 'user' as const, trusted: true, reason: 'message' },
      currentExecution: {
        trigger: 'user_message' as const,
        runId: 'run_test',
        objective: latestMessage,
      },
      latestMessage,
      messages: [{ role: 'user' as const, content: latestMessage }],
      tasks: [],
      memory: [],
      inbox: [],
      activeCommitments: [],
      stream: {
        signal: new AbortController().signal,
        writeTextDelta: async () => {},
        writeStatus: async () => {},
      },
      toolApprovalRequired: async (toolId: string) => toolId === 'deleteTask',
      tools,
      ...overrides,
    },
    tools,
  }
}

function textOf(
  result: Awaited<ReturnType<ReturnType<typeof createDemoResponder>>>,
) {
  if (result.status !== 'completed')
    throw new Error('completed response expected')
  return result.text
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function mockTextStream(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: text },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage,
        },
      ],
    }),
  }
}

function mockToolCallStream(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: {
            unified: 'tool-calls' as const,
            raw: 'tool_calls',
          },
          usage,
        },
      ],
    }),
  }
}

describe('demo responder', () => {
  test('turns an add request into a createTask tool call', async () => {
    const { value, tools } = input('Add book flights')

    const response = await createDemoResponder()(value)

    expect(textOf(response)).toBe('Added “book flights”.')
    expect(tools.createTask).toHaveBeenCalledWith({ title: 'book flights' })
  })

  test('schedules a relative reminder from the injected clock', async () => {
    const { value, tools } = input('Remind me in 15 minutes to check the oven')

    const response = await createDemoResponder()(value)

    expect(textOf(response)).toBe(
      'I’ll remind you to “check the oven” in 15 minutes.',
    )
    expect(tools.createCommitment).toHaveBeenCalledWith({
      title: 'check the oven',
      dueAt: '2026-08-24T10:15:00.000Z',
      execution: { kind: 'notify', message: 'check the oven' },
    })
  })

  test('completes a task by matching its title', async () => {
    const { value, tools } = input('Complete book flights', {
      tasks: [{ id: 'task_1', title: 'Book flights', done: false }],
    })

    const response = await createDemoResponder()(value)

    expect(textOf(response)).toBe('Completed “Book flights”.')
    expect(tools.completeTask).toHaveBeenCalledWith({ taskId: 'task_1' })
  })

  test('suspends the deterministic run before invoking a protected tool', async () => {
    const { value, tools } = input('Delete book flights', {
      tasks: [{ id: 'task_1', title: 'Book flights', done: false }],
      toolApprovalRequired: async () => true,
    })

    const response = await createDemoResponder()(value)

    expect(response).toMatchObject({
      status: 'waiting_for_approval',
      request: {
        tool: 'deleteTask',
        args: { taskId: 'task_1' },
      },
    })
    expect(tools.deleteTask).not.toHaveBeenCalled()
  })

  test('stores an explicit user memory under a stable normalized key', async () => {
    const { value, tools } = input('Remember that I prefer concise answers')

    const response = await createDemoResponder()(value)

    expect(textOf(response)).toBe('I’ll remember that.')
    expect(tools.remember).toHaveBeenCalledWith({
      key: 'i_prefer_concise_answers',
      value: 'I prefer concise answers',
    })
  })
})

describe('AI responder factory', () => {
  test('forwards model text deltas to the durable stream observer', async () => {
    const writeTextDelta = mock(async (_delta: string) => {})
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'Hello' },
            { type: 'text-delta', id: 'text-1', delta: ' world' },
            { type: 'text-end', id: 'text-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 2, text: 2, reasoning: 0 },
              },
            },
          ],
        }),
      },
    })
    const { value } = input('Hello', {
      stream: {
        signal: new AbortController().signal,
        writeTextDelta,
        writeStatus: async () => {},
      },
    } as Partial<AgentResponderInput>)

    const result = await createLanguageModelResponder(model)(value)

    expect(writeTextDelta).toHaveBeenNthCalledWith(1, 'Hello')
    expect(writeTextDelta).toHaveBeenNthCalledWith(2, ' world')
    expect(textOf(result)).toBe('Hello world')
  })

  test('builds the model tool set from the app-local agent declaration', () => {
    const { value } = input('List tasks')
    const modelTools = createModelTools(value)

    expect(Object.keys(modelTools).sort()).toEqual([
      'cancelCommitment',
      'completeTask',
      'createCommitment',
      'createTask',
      'deleteTask',
      'listCommitments',
      'listTasks',
      'pauseCommitment',
      'remember',
      'resumeCommitment',
      'retryCommitment',
    ])
  })

  test('maps the durable approval callback onto required model tools', async () => {
    const approvalRequired = mock(
      async (toolId: string, args: unknown) =>
        toolId === 'deleteTask' &&
        JSON.stringify(args) === JSON.stringify({ taskId: 'task_1' }),
    )
    const { value } = input('Delete book flights', {
      toolApprovalRequired: approvalRequired,
    })
    const modelTools = createModelTools(value)

    expect(
      await (modelTools.deleteTask as any).needsApproval({ taskId: 'task_1' }),
    ).toBe(true)
    expect((modelTools.createTask as any).needsApproval).toBe(false)
  })

  test('returns an exact waiting checkpoint instead of continuing after an approval tool call', async () => {
    const model = new MockLanguageModelV4({
      doStream: mockToolCallStream(
        'call_delete_1',
        'deleteTask',
        { taskId: 'task_1' },
      ),
    })
    const { value, tools } = input('Delete book flights', {
      toolApprovalRequired: async () => true,
    })

    const response = await createLanguageModelResponder(model)(value)

    expect(response).toMatchObject({
      status: 'waiting_for_approval',
      request: {
        toolCallId: 'call_delete_1',
        tool: 'deleteTask',
        args: { taskId: 'task_1' },
      },
    })
    expect(response.checkpoint.messages.at(-1)).toMatchObject({
      role: 'assistant',
    })
    expect(tools.deleteTask).not.toHaveBeenCalled()
    expect(model.doStreamCalls).toHaveLength(1)
  })

  test('delivers a commitment objective as trusted current execution', async () => {
    const model = new MockLanguageModelV4({
      doStream: mockTextStream('Stored the conclusion.'),
    })
    const { value } = input('Ignore this stale conversation', {
      currentExecution: {
        trigger: 'commitment',
        commitmentId: 'commitment_memory',
        runId: 'run_memory',
        objective: 'Store the session conclusion in long-term memory.',
        executionSpec: {
          kind: 'objective',
          prompt: 'Store the session conclusion in long-term memory.',
        },
      },
    })

    const response = await createLanguageModelResponder(model)(value)

    expect(response).toMatchObject({
      status: 'completed',
      text: 'Stored the conclusion.',
    })
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(
      'Store the session conclusion in long-term memory.',
    )
  })

  test('continues from an approved checkpoint and executes the protected tool once', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        mockToolCallStream('call_delete_resume', 'deleteTask', {
          taskId: 'task_1',
        }),
        mockTextStream('Deleted it.'),
      ],
    })
    const firstInput = input('Delete book flights', {
      toolApprovalRequired: async () => true,
    })
    const responder = createLanguageModelResponder(model)
    const suspended = await responder(firstInput.value)
    if (suspended.status !== 'waiting_for_approval') {
      throw new Error('approval checkpoint expected')
    }
    const resumedInput = input('Delete book flights', {
      checkpoint: suspended.checkpoint,
      approvalResponse: {
        approvalId: suspended.request.approvalId,
        approved: true,
      },
      toolApprovalRequired: async () => false,
    })

    const completedResponse = await responder(resumedInput.value)

    expect(textOf(completedResponse)).toBe('Deleted it.')
    expect(resumedInput.tools.deleteTask).toHaveBeenCalledTimes(1)
    expect(resumedInput.tools.deleteTask).toHaveBeenCalledWith({
      taskId: 'task_1',
    })
    expect(model.doStreamCalls).toHaveLength(2)
  })

  test('all model tool schemas are JSON Schema compliant and do not throw', () => {
    const { value } = input('List tasks')
    const modelTools = createModelTools(value)

    for (const [id, tool] of Object.entries(modelTools)) {
      expect(() => {
        const schema = z.toJSONSchema((tool as any).inputSchema)
        expect(schema).toBeDefined()
      }).not.toThrow()
    }
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
