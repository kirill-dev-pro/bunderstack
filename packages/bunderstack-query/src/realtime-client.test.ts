import { describe, it, expect } from 'bun:test'
import { QueryClient } from '@tanstack/query-core'
import { createRealtimeClient } from './realtime-client.ts'

// Minimal fake EventSource that lets the test push events.
class FakeES {
  static last: FakeES
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) { this.url = url; FakeES.last = this }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }) }
  close() {}
}

describe('createRealtimeClient', () => {
  it('on a create event, sets the detail cache and invalidates the list', async () => {
    const qc = new QueryClient()
    const fetchMock = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const rt = createRealtimeClient({
      baseUrl: 'http://x/api', queryClient: qc, tables: ['cards'],
      fetch: fetchMock, EventSourceImpl: FakeES as unknown as typeof EventSource,
    })
    // connect event
    FakeES.last.emit({ clientId: 'c1' })
    await rt.subscribe(['cards'])
    FakeES.last.emit({ action: 'create', table: 'cards', record: { id: 'card_1', title: 'A' } })

    expect(qc.getQueryData(['cards', 'detail', 'card_1'])).toEqual({ id: 'card_1', title: 'A' })
    rt.close()
  })
})
