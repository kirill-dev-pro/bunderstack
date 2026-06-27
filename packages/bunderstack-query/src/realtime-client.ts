import type { QueryClient } from '@tanstack/query-core'

import { createTableClient } from './table-client.ts'

// ---------------------------------------------------------------------------
// Transport choice: custom fetch + ReadableStream SSE reader (NOT EventSource).
//
// Why not native EventSource?
//  - Its reconnect is opaque and browser-throttled. Backgrounded/throttled tabs
//    are exactly where it stalls — the failure we are fixing (tab stops updating
//    until you interact with it).
//  - We cannot run our own heartbeat watchdog, backoff, or force a reconnect on
//    `visibilitychange` with EventSource.
//
// Why the custom reader?
//  - We own reconnect (explicit backoff), a heartbeat watchdog (no bytes within
//    ~1.5x keepalive => tear down + reconnect), and visibility-driven reconnect.
//
// Cost / when to reconsider: more code than `new EventSource(url)`, and we must
// parse SSE frames ourselves. If real-world testing shows native EventSource is
// adequate, the previous implementation was: `new EventSource(`${root}/realtime`,
// { withCredentials: true })` with `es.onmessage` doing the same `apply()` and a
// `postSubscribe` on the connect frame. Swap the connect loop below back to that.
// ---------------------------------------------------------------------------

type RealtimeEvent = {
  eventId: number
  action: 'create' | 'update' | 'delete'
  table: string
  record: Record<string, unknown>
}

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type RealtimeClientConfig = {
  baseUrl: string
  queryClient: QueryClient
  tables: string[]
  fetch?: typeof fetch
  /**
   * How often the server sends a keepalive ping (milliseconds). Defaults to 30 000.
   *
   * INVARIANT: this value MUST be >= the server's `realtime.keepaliveMs`.
   * The client watchdog fires at ~1.5× keepaliveMs; if this is set lower than
   * the server's interval, the watchdog reconnects before the server's ping
   * arrives and causes a reconnect storm.
   */
  keepaliveMs?: number
  onStatus?: (s: RealtimeStatus) => void
}

export function createRealtimeClient(config: RealtimeClientConfig) {
  const { baseUrl, queryClient, tables } = config
  const fetchFn = config.fetch ?? fetch
  const keepaliveMs = config.keepaliveMs ?? 30000
  const root = baseUrl.replace(/\/$/, '')

  const keysByTable = new Map(
    tables.map((t) => [t, createTableClient({ tableName: t, baseUrl: root, fetch: fetchFn }).keys]),
  )

  let clientId: string | null = null
  let lastTopics: string[] = []
  let lastEventId: number | null = null
  let closed = false
  let abort: AbortController | null = null
  let backoff = 1000
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let backoffTimer: ReturnType<typeof setTimeout> | null = null

  function setStatus(s: RealtimeStatus) { config.onStatus?.(s) }

  function apply(evt: RealtimeEvent) {
    const keys = keysByTable.get(evt.table)
    if (!keys) return
    if (typeof evt.eventId === 'number') lastEventId = evt.eventId
    const id = evt.record['id'] as string | number
    if (evt.action === 'delete') queryClient.removeQueries({ queryKey: keys.detail(id) })
    else queryClient.setQueryData(keys.detail(id), evt.record)
    queryClient.invalidateQueries({ queryKey: keys.lists() })
  }

  function invalidateAllSubscribed() {
    for (const t of tables) {
      const keys = keysByTable.get(t)
      if (keys) queryClient.invalidateQueries({ queryKey: keys.lists() })
    }
  }

  async function postSubscribe(topics: string[]) {
    if (!clientId) return
    const res = await fetchFn(`${root}/realtime`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, subscriptions: topics, since: lastEventId }),
    })
    const body = (await res.json().catch(() => ({}))) as { gap?: boolean }
    if (body.gap) invalidateAllSubscribed()
  }

  function armWatchdog() {
    if (watchdog) clearTimeout(watchdog)
    // No bytes (event or `: ping`) within 1.5x keepalive => assume dead, reconnect.
    watchdog = setTimeout(() => { abort?.abort() }, Math.round(keepaliveMs * 1.5))
  }

  function handleFrame(frame: string) {
    armWatchdog()
    // Comment lines (": ping") are liveness only.
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'))
    if (!dataLines.length) return
    const json = dataLines.map((l) => l.slice(5).trim()).join('\n')
    let data: unknown
    try { data = JSON.parse(json) } catch { return }
    if (data && typeof data === 'object' && 'clientId' in data && (data as any).clientId) {
      clientId = (data as any).clientId
      if (lastTopics.length) void postSubscribe(lastTopics)
      return
    }
    apply(data as RealtimeEvent)
  }

  async function connectLoop() {
    while (!closed) {
      abort = new AbortController()
      setStatus(clientId ? 'reconnecting' : 'connecting')
      try {
        const res = await fetchFn(`${root}/realtime`, {
          credentials: 'include',
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        })
        if (!res.body) throw new Error('no body')
        setStatus('open')
        backoff = 1000
        armWatchdog()
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            handleFrame(frame)
          }
        }
      } catch {
        /* fallthrough to reconnect */
      }
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      if (closed) break
      // Reconnect with jittered backoff (cap 30s). lastEventId drives replay.
      const wait = Math.min(backoff, 30000) * (0.5 + Math.random())
      backoff = Math.min(backoff * 2, 30000)
      await new Promise<void>((r) => { backoffTimer = setTimeout(r, wait) })
      backoffTimer = null
    }
    setStatus('closed')
  }

  // Refocus => force an immediate reconnect + catch-up (no waiting on backoff).
  const onVisible = () => {
    if (closed) return
    if (document.visibilityState === 'visible') {
      backoff = 1000
      abort?.abort()
    }
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)

  void connectLoop()

  return {
    async subscribe(topics: string[]) {
      lastTopics = topics
      await postSubscribe(topics)
    },
    close() {
      closed = true
      if (watchdog) { clearTimeout(watchdog); watchdog = null }
      if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
      abort?.abort()
      setStatus('closed')
    },
  }
}
