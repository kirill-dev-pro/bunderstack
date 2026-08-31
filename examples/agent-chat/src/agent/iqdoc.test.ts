import { describe, expect, mock, test } from 'bun:test'
import { generateTypeId, parseTypeId } from 'bunderstack'

import {
  createIQDocResponder,
  createIQDocInterceptingFetch,
  type IQDocCalculatorResult,
} from './iqdoc'
import type { AgentResponderInput, AgentTools } from './types'

const encoder = new TextEncoder()

function streamingResponse(chunks: string[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )
}

describe('IQdoc stream interceptor', () => {
  test('extracts distinct statuses and calculator results across byte boundaries', async () => {
    const statuses: string[] = []
    const calculators: IQDocCalculatorResult[] = []
    const source = [
      'data: {"choices":[{"delta":{"status":"Searching PubMed"}}]}\n\n',
      'data: {"choices":[{"delta":{"status":"Searching PubMed"}}]}\n\n',
      'data: {"choices":[{"delta":{"calculator_result":{"ok":true,"calculator_id":"bmi","name":"BMI","values":{"result":24.2}}}}]}\n',
      '\ndata: {"choices":[{"delta":{"status":"Preparing answer"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Result"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const baseFetch = mock(async () => streamingResponse(source))
    const interceptedFetch = createIQDocInterceptingFetch(baseFetch, {
      onStatus: async (status) => {
        statuses.push(status)
      },
      onCalculatorResult: async (result) => {
        calculators.push(result)
      },
    })

    const response = await interceptedFetch('https://iqdoc.example/stream')
    const forwarded = await response.text()

    expect(statuses).toEqual(['Searching PubMed', 'Preparing answer'])
    expect(calculators).toEqual([
      {
        ok: true,
        calculator_id: 'bmi',
        name: 'BMI',
        values: { result: 24.2 },
      },
    ])
    expect(forwarded).toContain('"content":"Result"')
    expect(forwarded).toContain('data: [DONE]')
    expect(forwarded).not.toContain('calculator_result')
    expect(forwarded).not.toContain('Searching PubMed')
  })

  test('removes IQdoc fields from a mixed delta without losing standard content', async () => {
    const statuses: string[] = []
    const baseFetch = mock(async () =>
      streamingResponse([
        ': keepalive\r\n\r\n',
        'data: {"choices":[{"delta":{"content":"Still here","status":"Reading sources"}}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]),
    )
    const interceptedFetch = createIQDocInterceptingFetch(baseFetch, {
      onStatus: (status) => {
        statuses.push(status)
      },
      onCalculatorResult: () => {},
    })

    const forwarded = await (
      await interceptedFetch('https://iqdoc.example/stream')
    ).text()

    expect(statuses).toEqual(['Reading sources'])
    expect(forwarded).toContain(': keepalive')
    expect(forwarded).toContain('"content":"Still here"')
    expect(forwarded).not.toContain('"status"')
  })

  test('passes malformed events and non-stream responses through unchanged', async () => {
    const sseFetch = mock(async () =>
      streamingResponse(['data: {not-json}\n\ndata: [DONE]\n\n']),
    )
    const callbacks = {
      onStatus: mock(() => {}),
      onCalculatorResult: mock(() => {}),
    }

    const sseText = await (
      await createIQDocInterceptingFetch(sseFetch, callbacks)(
        'https://iqdoc.example/stream',
      )
    ).text()

    expect(sseText).toBe('data: {not-json}\n\ndata: [DONE]\n\n')
    expect(callbacks.onStatus).not.toHaveBeenCalled()
    expect(callbacks.onCalculatorResult).not.toHaveBeenCalled()

    const failed = new Response('{"error":"nope"}', {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
    const failedFetch = mock(async () => failed)
    const result = await createIQDocInterceptingFetch(
      failedFetch,
      callbacks,
    )('https://iqdoc.example/stream')

    expect(result).toBe(failed)
    expect(await result.text()).toBe('{"error":"nope"}')
  })
})

describe('IQdoc responder', () => {
  test('defers a missing endpoint error into the durable responder lifecycle', async () => {
    let responder: ReturnType<typeof createIQDocResponder> | undefined

    expect(() => {
      responder = createIQDocResponder({ apiKey: 'iqdoc-secret' })
    }).not.toThrow()

    const threadId = generateTypeId('athread')
    const runId = generateTypeId('arun')
    await expect(
      responder!(
        responderInput(threadId, runId, {
          writeTextDelta: async () => {},
          writeActivity: async () => {},
        }),
      ),
    ).rejects.toThrow('IQDOC_BASE_URL is required when IQdoc is enabled')
  })

  test('uses the IQdoc request contract without exposing Bunderstack tools', async () => {
    const threadId = generateTypeId('athread')
    const runId = generateTypeId('arun')
    const textDeltas: string[] = []
    const activities: Array<{
      kind: string
      title: string
      output?: unknown
    }> = []
    let captured:
      | { url: string; headers: Headers; body: Record<string, unknown> }
      | undefined
    const providerFetch = mock(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        captured = {
          url: String(request),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        }
        return streamingResponse([
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"pubmed_assistant_fast","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"pubmed_assistant_fast","choices":[{"index":0,"delta":{"status":"Searching PubMed"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"pubmed_assistant_fast","choices":[{"index":0,"delta":{"calculator_result":{"ok":true,"calculator_id":"bmi","name":"BMI"}},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"pubmed_assistant_fast","choices":[{"index":0,"delta":{"content":"Clinical answer"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"pubmed_assistant_fast","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ])
      },
    )
    const responder = createIQDocResponder({
      apiKey: 'iqdoc-secret',
      baseURL: 'https://iqdoc.example/api/v1/',
      model: 'pubmed_assistant_fast',
      fetch: providerFetch,
    })

    const result = await responder(
      responderInput(threadId, runId, {
        writeTextDelta: async (delta) => {
          textDeltas.push(delta)
        },
        writeActivity: async (activity) => {
          activities.push(activity)
        },
      }),
    )

    expect(captured?.url).toBe(
      'https://iqdoc.example/api/v1/chat/completions',
    )
    expect(captured?.headers.get('X-Api-Key')).toBe('iqdoc-secret')
    expect(captured?.headers.get('X-Chat-Id')).toBe(parseTypeId(threadId).uuid)
    expect(captured?.headers.get('X-Message-Id')).toBe(parseTypeId(runId).uuid)
    expect(captured?.body.model).toBe('pubmed_assistant_fast')
    expect(captured?.body.tools).toBeUndefined()
    expect(textDeltas.join('')).toBe('Clinical answer')
    expect(activities).toEqual([
      { kind: 'status', title: 'Searching PubMed' },
      {
        kind: 'tool_call',
        title: 'BMI',
        output: { ok: true, calculator_id: 'bmi', name: 'BMI' },
      },
    ])
    expect(result).toMatchObject({
      status: 'completed',
      text: 'Clinical answer',
    })
  })
})

function responderInput(
  threadId: string,
  runId: string,
  stream: Pick<
    AgentResponderInput['stream'],
    'writeTextDelta' | 'writeActivity'
  >,
): AgentResponderInput {
  const tools = {} as AgentTools
  return {
    threadId,
    reason: 'message',
    now: new Date('2026-08-31T12:00:00.000Z'),
    instructions: 'Unused by the upstream IQdoc agent',
    trigger: { type: 'user', trusted: true, reason: 'message' },
    currentExecution: {
      trigger: 'user_message',
      runId,
      objective: 'Give a clinical answer',
    },
    latestMessage: 'Give a clinical answer',
    messages: [{ role: 'user', content: 'Give a clinical answer' }],
    tasks: [],
    memory: [],
    inbox: [],
    activeCommitments: [],
    stream: {
      signal: new AbortController().signal,
      writeStatus: async () => {},
      ...stream,
    },
    toolApprovalRequired: async () => false,
    tools,
  }
}
