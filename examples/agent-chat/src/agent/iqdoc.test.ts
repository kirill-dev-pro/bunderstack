import { describe, expect, mock, test } from 'bun:test'

import {
  createIQDocInterceptingFetch,
  type IQDocCalculatorResult,
} from './iqdoc'

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
      onStatus: (status) => statuses.push(status),
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
