import { expect, mock, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'

import { createConfiguredResponder } from './provider'
import type { AgentResponderInput } from './types'

test('selects the explicitly configured IQdoc responder', async () => {
  const providerFetch = mock(async () =>
    new Response(
      [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"assistant_auto","choices":[{"index":0,"delta":{"content":"IQdoc selected"},"finish_reason":null}]}',
        '',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"assistant_auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  )
  const responder = createConfiguredResponder({
    provider: 'iqdoc',
    openai: { apiKey: 'openai-secret' },
    iqdoc: {
      apiKey: 'iqdoc-secret',
      baseURL: 'https://iqdoc.example/api/v1',
      fetch: providerFetch,
    },
  })

  const result = await responder(providerInput())

  expect(providerFetch).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ status: 'completed', text: 'IQdoc selected' })
})

test('preserves the existing OpenAI responder selection', () => {
  const responder = createConfiguredResponder({
    provider: 'openai',
    openai: { apiKey: 'openai-secret', model: 'gpt-5-mini' },
    iqdoc: { apiKey: 'iqdoc-secret' },
  })

  expect(typeof responder).toBe('function')
})

function providerInput(): AgentResponderInput {
  const runId = generateTypeId('arun')
  return {
    threadId: generateTypeId('athread'),
    reason: 'message',
    now: new Date('2026-08-31T12:00:00.000Z'),
    instructions: 'Test',
    trigger: { type: 'user', trusted: true, reason: 'message' },
    currentExecution: {
      trigger: 'user_message',
      runId,
      objective: 'Test IQdoc',
    },
    latestMessage: 'Test IQdoc',
    messages: [{ role: 'user', content: 'Test IQdoc' }],
    tasks: [],
    memory: [],
    inbox: [],
    activeCommitments: [],
    stream: {
      signal: new AbortController().signal,
      writeTextDelta: async () => {},
      writeStatus: async () => {},
      writeActivity: async () => {},
    },
    toolApprovalRequired: async () => false,
    tools: {} as AgentResponderInput['tools'],
  }
}
