import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Both must be set before importing ./bunderstack — that module builds the app
// at import time. `web` keeps a background worker from auto-starting, so job
// execution stays deterministic and driven by app.jobs.tick() below.
process.env.DATABASE_URL = `file:${join(tmpdir(), `todo-solid-2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}`
process.env.BUNDERSTACK_ROLE = 'web'

const { app, todos } = await import('./bunderstack')
const { provision } = await import('bunderstack/provision')
await provision(app, { force: true })

async function createTodo(title: string) {
  const res = await app.handler(
    new Request('http://localhost/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
  // The generated create route answers 201, not 200.
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

test('summary columns are not writable through the CRUD route', async () => {
  const created = await createTodo('locked')

  const res = await app.handler(
    new Request(`http://localhost/api/todos/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'renamed',
        summary: 'injected',
        summaryStatus: 'done',
      }),
    }),
  )
  expect(res.status).toBe(200)

  const [row] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))

  // The allowlisted column took the write; the server-owned ones did not.
  expect(row!.title).toBe('renamed')
  expect(row!.summary).toBeNull()
  expect(row!.summaryStatus).toBe('idle')
})
