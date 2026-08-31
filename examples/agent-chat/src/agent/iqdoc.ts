import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, type ModelMessage } from 'ai'
import { parseTypeId } from 'bunderstack'

import { createDemoResponder } from './model'
import type { AgentResponder } from './types'

export const IQDOC_MODEL_IDS = [
  'assistant_auto',
  'pubmed_assistant_fast',
  'clinrec_assistant_fast',
  'standart_assistant_fast',
  'esmo_assistant_fast',
  'asa_assistant_fast',
  'far_assistant_fast',
  'assistant_pro',
] as const

export type IQDocModelId = (typeof IQDOC_MODEL_IDS)[number]

export type IQDocFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface IQDocResponderOptions {
  apiKey?: string
  baseURL?: string
  model?: IQDocModelId | (string & {})
  fetch?: IQDocFetch
}

export interface IQDocCalculatorResult {
  ok: boolean
  calculator_id?: string
  name?: string
  values?: Record<string, unknown>
  interpretation?: string | null
  incomplete?: boolean
  error?: string
  params?: Record<string, unknown>
  raw_params?: Record<string, unknown>
}

export interface IQDocStreamCallbacks {
  onStatus(status: string): void | Promise<void>
  onCalculatorResult(
    result: IQDocCalculatorResult,
  ): void | Promise<void>
}

export function createIQDocResponder(
  options: IQDocResponderOptions = {},
): AgentResponder {
  if (!options.apiKey?.trim()) return createDemoResponder()
  if (!options.baseURL?.trim()) {
    throw new Error('IQDOC_BASE_URL is required when IQdoc is enabled')
  }

  return async (input) => {
    const providerFetch = createIQDocInterceptingFetch(
      options.fetch ?? fetch,
      {
        onStatus: async (status) => {
          await input.stream.writeActivity({ kind: 'status', title: status })
        },
        onCalculatorResult: async (result) => {
          await input.stream.writeActivity({
            kind: 'tool_call',
            title: result.name ?? result.calculator_id ?? 'Calculator result',
            output: result,
          })
        },
      },
    )
    const provider = createOpenAICompatible({
      name: 'iqdoc',
      baseURL: options.baseURL!.replace(/\/+$/, ''),
      includeUsage: true,
      headers: { 'X-Api-Key': options.apiKey!.trim() },
      fetch: providerFetch as unknown as typeof fetch,
    })
    const messages: ModelMessage[] = input.messages.map((message) => ({
      role: message.role === 'system' ? ('user' as const) : message.role,
      content:
        message.role === 'system'
          ? `[System]: ${message.content}`
          : message.content,
    }))
    const result = streamText({
      model: provider.chatModel(options.model ?? 'assistant_auto'),
      messages,
      headers: {
        'X-Chat-Id': parseTypeId(input.threadId, 'athread').uuid,
        'X-Message-Id': parseTypeId(
          input.currentExecution.runId,
          'arun',
        ).uuid,
      },
      maxRetries: 0,
      abortSignal: input.stream.signal,
    })

    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        await input.stream.writeTextDelta(chunk.text)
      }
    }

    return {
      status: 'completed',
      text: await result.text,
      checkpoint: {
        messages: [...messages, ...(await result.responseMessages)],
      },
    }
  }
}

const IQDOC_DELTA_KEYS = new Set([
  'status',
  'transcription',
  'calculator_result',
])

export function createIQDocInterceptingFetch(
  baseFetch: IQDocFetch,
  callbacks: IQDocStreamCallbacks,
): IQDocFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await baseFetch(input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (
      !response.ok ||
      !response.body ||
      !contentType.includes('text/event-stream')
    ) {
      return response
    }

    return new Response(
      filterIQDocStream(response.body, callbacks),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )
  })
}

function filterIQDocStream(
  source: ReadableStream<Uint8Array>,
  callbacks: IQDocStreamCallbacks,
) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const reader = source.getReader()
  let buffer = ''
  let lastStatus: string | undefined

  const processEvent = async (rawEvent: string) => {
    if (rawEvent.trimStart().startsWith(':')) return rawEvent

    let providerOnly = false
    let parsedProviderEvent = false
    const outputLines: string[] = []

    for (const line of rawEvent.split('\n')) {
      if (!line.startsWith('data:')) {
        outputLines.push(line)
        continue
      }
      const rawData = line.slice(5).trim()
      if (!rawData || rawData === '[DONE]') {
        outputLines.push(line)
        continue
      }

      let payload: unknown
      try {
        payload = JSON.parse(rawData)
      } catch {
        outputLines.push(line)
        continue
      }
      if (!isRecord(payload) || !Array.isArray(payload.choices)) {
        outputLines.push(line)
        continue
      }

      let intercepted = false
      let hasStandardDelta = false
      for (const choice of payload.choices) {
        if (!isRecord(choice) || !isRecord(choice.delta)) continue
        const delta = choice.delta
        const status = delta.status
        if (
          typeof status === 'string' &&
          status.length > 0 &&
          status !== lastStatus
        ) {
          lastStatus = status
          await callbacks.onStatus(status)
        }
        const calculator = calculatorResult(delta.calculator_result)
        if (calculator) await callbacks.onCalculatorResult(calculator)

        for (const key of IQDOC_DELTA_KEYS) {
          if (key in delta) {
            delete delta[key]
            intercepted = true
          }
        }
        if (Object.keys(delta).length > 0) hasStandardDelta = true
      }

      if (!intercepted) {
        outputLines.push(line)
        continue
      }
      parsedProviderEvent = true
      providerOnly = !hasStandardDelta
      if (hasStandardDelta) outputLines.push(`data: ${JSON.stringify(payload)}`)
    }

    if (parsedProviderEvent && providerOnly && outputLines.length === 0) {
      return null
    }
    return outputLines.join('\n')
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const separator = buffer.indexOf('\n\n')
        if (separator >= 0) {
          const rawEvent = buffer.slice(0, separator)
          buffer = buffer.slice(separator + 2)
          const event = await processEvent(rawEvent)
          if (event !== null && event.length > 0) {
            controller.enqueue(encoder.encode(`${event}\n\n`))
            return
          }
          continue
        }

        try {
          const { done, value } = await reader.read()
          if (done) {
            buffer += decoder.decode()
            buffer = buffer.replace(/\r\n/g, '\n')
            if (buffer.trim()) {
              const event = await processEvent(buffer)
              if (event !== null && event.length > 0) {
                controller.enqueue(encoder.encode(`${event}\n\n`))
              }
            }
            buffer = ''
            controller.close()
            return
          }
          buffer += decoder.decode(value, { stream: true })
          buffer = buffer.replace(/\r\n/g, '\n')
        } catch (error) {
          controller.error(error)
          return
        }
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
}

function calculatorResult(value: unknown): IQDocCalculatorResult | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return undefined
  return value as unknown as IQDocCalculatorResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
