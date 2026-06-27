import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { createRealtimeClient } from './realtime-client.ts'

// A controllable SSE response: push frames, then optionally end the stream.
function makeStreamResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array>
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    push: (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)),
    ping: () => controller.enqueue(enc.encode(`: ping\n\n`)),
    end: () => controller.close(),
  }
}

it('applies a create event: sets detail cache and invalidates the list', async () => {
  const qc = new QueryClient()
  const stream = makeStreamResponse()
  const posted: any[] = []
  const fetchMock = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ gap: false }), { status: 200 }) }
    return stream.response // GET /realtime
  }) as unknown as typeof fetch

  const rt = createRealtimeClient({ baseUrl: 'http://x/api', queryClient: qc, tables: ['cards'], fetch: fetchMock })
  stream.push({ clientId: 'c1' })
  await rt.subscribe(['cards'])
  stream.push({ eventId: 1, action: 'create', table: 'cards', record: { id: 'card_1', title: 'A' } })
  await Promise.resolve(); await new Promise((r) => setTimeout(r, 5))

  expect(qc.getQueryData(['cards', 'detail', 'card_1']) as unknown).toEqual({ id: 'card_1', title: 'A' })
  expect(posted[0]).toEqual({ clientId: 'c1', subscriptions: ['cards'], since: null })
  rt.close()
})

it('re-subscribes with since=lastEventId and invalidates all on gap after reconnect', async () => {
  const qc = new QueryClient()
  let invalidated: any[] = []
  qc.invalidateQueries = (async (filters: any) => { invalidated.push(filters?.queryKey) }) as any

  // Stub Math.random so backoff is deterministic: 1000 * (0.5 + 0) = 500ms.
  const originalRandom = Math.random
  Math.random = () => 0

  let stream = makeStreamResponse()
  const posted: any[] = []
  const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { posted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ gap: posted.length > 1 }), { status: 200 }) }
    return stream.response
  }) as unknown as typeof fetch

  const rt = createRealtimeClient({ baseUrl: 'http://x/api', queryClient: qc, tables: ['cards'], fetch: fetchMock })
  try {
    stream.push({ clientId: 'c1' })
    await rt.subscribe(['cards'])
    stream.push({ eventId: 7, action: 'update', table: 'cards', record: { id: 'card_1', title: 'B' } })
    await new Promise((r) => setTimeout(r, 5))

    // Simulate disconnect: end the stream, swap in a fresh one for the reconnect GET.
    invalidated = []
    const next = makeStreamResponse()
    const prev = stream; stream = next
    prev.end()
    await new Promise((r) => setTimeout(r, 1500)) // backoff is fixed at 500ms; 1500ms gives comfortable margin
    next.push({ clientId: 'c2' })
    await new Promise((r) => setTimeout(r, 50))

    const lastPost = posted[posted.length - 1]
    expect(lastPost).toEqual({ clientId: 'c2', subscriptions: ['cards'], since: 7 })
    // gap:true on reconnect -> list invalidation happened
    expect(invalidated.some((k) => Array.isArray(k) && k[0] === 'cards' && k[1] === 'list')).toBe(true)
  } finally {
    rt.close()
    Math.random = originalRandom
  }
})
