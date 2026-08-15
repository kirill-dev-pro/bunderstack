import { expect, spyOn, test } from 'bun:test'
import { eq, getTableName } from 'drizzle-orm'
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

type Published = {
  table: string
  action: string
  record: Record<string, unknown>
}

function capturePublishes(): Published[] {
  const events: Published[] = []
  spyOn(app.realtime, 'publish').mockImplementation(
    async (table, action, record) => {
      events.push({
        table: getTableName(table),
        action,
        record: record as unknown as Record<string, unknown>,
      })
    },
  )
  return events
}

async function enrich() {
  const res = await app.handler(
    new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { queued: number }
}

test('the trigger will not disturb a run already in flight', async () => {
  await createTodo('claim me')

  const first = await enrich()
  expect(first.queued).toBeGreaterThan(0)

  // Everything is `queued` now, so a second click finds nothing claimable and
  // cannot double-enqueue rows the worker is about to pick up.
  const second = await enrich()
  expect(second.queued).toBe(0)
})

test('re-summarising a finished row clears its old summary and runs again', async () => {
  const created = await createTodo('summarise me twice')
  await enrich()
  await app.jobs.tick()

  const [first] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))
  expect(first!.summaryStatus).toBe('done')
  const firstSummary = first!.summary
  expect(firstSummary).toBeTruthy()

  // The button must never be a no-op just because everything is summarised:
  // a finished row is claimable again, and its stale text is cleared at
  // claim time so the UI streams from empty rather than mutating in place.
  const again = await enrich()
  expect(again.queued).toBeGreaterThan(0)

  const [claimed] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))
  expect(claimed!.summaryStatus).toBe('queued')
  expect(claimed!.summary).toBeNull()

  await app.jobs.tick()

  const [second] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))
  expect(second!.summaryStatus).toBe('done')
  expect(second!.summary).toBeTruthy()
}, 30_000)

test('the job streams a growing summary and ends done', async () => {
  const created = await createTodo('stream me')
  await enrich()

  const events = capturePublishes()
  // One tick claims and runs every pending job, including the one the
  // previous test enqueued — the tests share a module-level app and
  // database. Filtering by row id below is what keeps this test's
  // assertions about its own todo.
  await app.jobs.tick()

  const mine = events.filter(
    (e) => e.table === 'todos' && e.record.id === created.id,
  )

  // More than one publish for a single row is the whole point: the summary
  // arrives in pieces rather than in one final write.
  expect(mine.length).toBeGreaterThan(2)

  // Only the per-word publishes, which all carry status `streaming`. The
  // terminal `done` publish repeats the final text, so including it would
  // break the strict-growth check below for the wrong reason.
  const texts = mine
    .filter((e) => e.record.summaryStatus === 'streaming')
    .map((e) => e.record.summary)
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
  expect(texts.length).toBeGreaterThan(1)
  for (let i = 1; i < texts.length; i++) {
    // Each publish carries the whole accumulated text, so it only ever grows
    // and every earlier value is a prefix of the next.
    expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true)
    expect(texts[i]!.length).toBeGreaterThan(texts[i - 1]!.length)
  }

  expect(mine.at(-1)!.record.summaryStatus).toBe('done')

  const [row] = await app.db
    .select()
    .from(todos)
    .where(eq(todos.id, created.id as never))
  expect(row!.summaryStatus).toBe('done')
  expect(row!.summary!.split(' ').length).toBeGreaterThanOrEqual(4)
  expect(row!.summary!.split(' ').length).toBeLessThanOrEqual(10)
}, 20_000)
