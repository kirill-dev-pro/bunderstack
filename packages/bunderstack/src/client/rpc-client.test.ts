import { eventIterator } from '@orpc/server'
import { expect, test } from 'bun:test'
import { pgTable, text } from 'drizzle-orm/pg-core'
import * as v from 'valibot'

import { pglite } from '../database/pglite'
import { createBunderstack } from '../index'
import { createClient } from './rpc-client'

const marker = pgTable('client_test_marker', {
  id: text('id').primaryKey(),
})

async function setupApp() {
  return createBunderstack({
    schema: { marker },
    database: { adapter: pglite() },
    processEnv: { DATABASE_URL: 'memory://', BUNDERSTACK_ROLE: 'web' },
    api: (o) => ({
      test: {
        echo: o.public
          .input(v.object({ value: v.string() }))
          .handler(({ input, context }) => ({
            value: input.value,
            operationId: context.request.headers.get(
              'x-bunderstack-operation-id',
            ),
          })),
        events: o.public
          .output(
            eventIterator(
              v.object({
                type: v.literal('snapshot'),
                items: v.array(v.string()),
              }),
            ),
          )
          .handler(() =>
            (async function* () {
              yield { type: 'snapshot' as const, items: ['typed stream'] }
            })(),
          ),
      },
    }),
  })
}

test('App-inferred client calls oRPC and forwards operation metadata', async () => {
  const app = await setupApp()
  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
  })

  const result = await client.test.echo(
    { value: 'No codegen' },
    { operationId: 'op-123' },
  )

  expect(result).toEqual({ value: 'No codegen', operationId: 'op-123' })
  await app.close()
})

test('client root is not accidentally thenable', async () => {
  const app = await setupApp()
  const client = createClient<typeof app>()

  expect((client as { then?: unknown }).then).toBeUndefined()
  await app.close()
})

test('App-inferred streaming procedure remains an async iterator', async () => {
  const app = await setupApp()
  const client = createClient<typeof app>({
    baseUrl: 'http://localhost/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
  })

  const stream = await client.test.events()
  expect(await stream.next()).toEqual({
    done: false,
    value: { type: 'snapshot', items: ['typed stream'] },
  })
  await app.close()
})
