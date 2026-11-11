import { expect, test } from 'bun:test'

import {
  isReadOnlyPipeline,
  isRemoteLibsqlUrl,
  retryingReadFetch,
} from './libsql-retry'

const URL = 'https://db.example.turso.io/v2/pipeline'

function pipeline(sql: string, baton: string | null = null): string {
  return JSON.stringify({
    baton,
    requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
  })
}

function request(body: string): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

const noDelay = async () => {}

test('only reads outside a stream count as replayable', () => {
  expect(isReadOnlyPipeline(pipeline('select "code" from "plan"'))).toBe(true)
  expect(
    isReadOnlyPipeline(pipeline('with x as (select 1) select * from x')),
  ).toBe(true)
  expect(isReadOnlyPipeline(pipeline('insert into "plan" values (?)'))).toBe(
    false,
  )
  expect(
    isReadOnlyPipeline(
      pipeline('with x as (select 1) insert into "plan" select * from x'),
    ),
  ).toBe(false)
  expect(isReadOnlyPipeline(pipeline('select 1', 'baton-1'))).toBe(false)
  expect(
    isReadOnlyPipeline(JSON.stringify({ baton: null, requests: [] })),
  ).toBe(false)
  expect(
    isReadOnlyPipeline(
      JSON.stringify({ baton: null, requests: [{ type: 'close' }] }),
    ),
  ).toBe(false)
  expect(isReadOnlyPipeline('not json')).toBe(false)
})

test('a read that hits a dropped connection is sent once more', async () => {
  const bodies: string[] = []
  let calls = 0
  const fetch = retryingReadFetch(async (req) => {
    bodies.push(await req.text())
    calls++
    if (calls === 1) throw new TypeError('ECONNRESET')
    return new Response('{}', { status: 200 })
  }, noDelay)
  const response = await fetch(request(pipeline('select 1')))
  expect(response.status).toBe(200)
  expect(calls).toBe(2)
  expect(bodies[1]).toBe(bodies[0])
})

test('a read answered 520 is sent once more, and only once', async () => {
  let calls = 0
  const fetch = retryingReadFetch(async () => {
    calls++
    return new Response('edge', { status: 520 })
  }, noDelay)
  const response = await fetch(request(pipeline('select 1')))
  expect(response.status).toBe(520)
  expect(calls).toBe(2)
})

test('a write is never replayed', async () => {
  let calls = 0
  const fetch = retryingReadFetch(async () => {
    calls++
    throw new TypeError('ECONNRESET')
  }, noDelay)
  await expect(
    fetch(request(pipeline('insert into "jobs" values (?)'))),
  ).rejects.toThrow('ECONNRESET')
  expect(calls).toBe(1)
})

test('a client error is returned as is', async () => {
  let calls = 0
  const fetch = retryingReadFetch(async () => {
    calls++
    return new Response('bad', { status: 400 })
  }, noDelay)
  expect((await fetch(request(pipeline('select 1')))).status).toBe(400)
  expect(calls).toBe(1)
})

test('only network URLs get the retrying fetch', () => {
  expect(isRemoteLibsqlUrl('libsql://db.turso.io')).toBe(true)
  expect(isRemoteLibsqlUrl('https://db.turso.io')).toBe(true)
  expect(isRemoteLibsqlUrl('file:local.db')).toBe(false)
  expect(isRemoteLibsqlUrl(':memory:')).toBe(false)
})
