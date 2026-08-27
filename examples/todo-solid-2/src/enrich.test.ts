import { expect, spyOn, test } from 'bun:test'
import { eq, getTableName } from 'drizzle-orm'

import { backend, todos } from './bunderstack'

test('summary columns are not writable through the CRUD route', async () => {
  await using fixture = await backend.test()
  const { app } = fixture

  const createdRes = await app.handler(
    new Request('http://localhost/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'locked' }),
    }),
  )
  expect(createdRes.status).toBe(201)
  const created = (await createdRes.json()) as { id: string }

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

test('the trigger will not disturb a run already in flight', async () => {
  await using fixture = await backend.test()
  const { app } = fixture

  const createRes = await app.handler(
    new Request('http://localhost/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'claim me' }),
    }),
  )
  expect(createRes.status).toBe(201)

  const firstRes = await app.handler(
    new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(firstRes.status).toBe(200)
  const first = (await firstRes.json()) as { queued: number }
  expect(first.queued).toBeGreaterThan(0)

  // Everything is `queued` now, so a second click finds nothing claimable and
  // cannot double-enqueue rows the worker is about to pick up.
  const secondRes = await app.handler(
    new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(secondRes.status).toBe(200)
  const second = (await secondRes.json()) as { queued: number }
  expect(second.queued).toBe(0)
})

test('the job streams a growing summary and ends done', async () => {
  await using fixture = await backend.test()
  const { app } = fixture

  const createRes = await app.handler(
    new Request('http://localhost/api/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'stream me' }),
    }),
  )
  expect(createRes.status).toBe(201)
  const created = (await createRes.json()) as { id: string }

  const enrichRes = await app.handler(
    new Request('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(enrichRes.status).toBe(200)

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

  await fixture.jobs.runUntilIdle()

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
