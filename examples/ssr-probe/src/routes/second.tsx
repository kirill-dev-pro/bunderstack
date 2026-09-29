import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'

import { api } from '../api'

const countNotes = createServerFn({ method: 'GET' }).handler(async () =>
  api.notes.list.call({ limit: 100 }).then(
    (page) => ({ status: 200, count: page.items.length }),
    (error: { status?: number }) => ({ status: error.status ?? 500, count: -1 }),
  ),
)

export const Route = createFileRoute('/second')({
  loader: () => countNotes(),
  component: () => {
    const data = Route.useLoaderData()
    return (
      <main>
        <p id="second">
          notes via server fn: status {data.status}, count {data.count}
        </p>
        <Link to="/">home</Link>
      </main>
    )
  },
})
