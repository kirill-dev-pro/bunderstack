import { createFileRoute, Link } from '@tanstack/react-router'
import * as React from 'react'

import { api } from '../api'

export const Route = createFileRoute('/')({
  loader: async () => {
    const events = await api.events.list
      .call({ limit: 5 })
      .then(
        (page) => ({ status: 200, count: page.items.length }),
        (error: { status?: number }) => ({ status: error.status ?? 500, count: -1 }),
      )
    return { events, renderedAt: new Date().toISOString() }
  },
  component: Home,
})

function Home() {
  const { events, renderedAt } = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const [clicks, setClicks] = React.useState(0)
  const [live, setLive] = React.useState<string[]>([])
  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const res = await fetch('/api/live/notes', {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        if (value.includes('title')) setLive((l) => [...l, value.slice(0, 160)])
      }
    })().catch(() => {})
    return () => controller.abort()
  }, [])
  return (
    <main>
      <h1 id="ssr">SSR probe rendered at {renderedAt}</h1>
      <p id="user">user: {user ? user.email : 'anonymous'}</p>
      <p id="events">
        events status {events.status} count {events.count}
      </p>
      <button id="hydrated" onClick={() => setClicks((c) => c + 1)}>
        clicks {clicks}
      </button>
      <Link to="/second" id="to-second">
        second
      </Link>
      <pre id="live">{live.join('\n')}</pre>
    </main>
  )
}
