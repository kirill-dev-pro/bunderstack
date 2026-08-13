import { createProcedureClient, ORPCError } from '@orpc/server'
import { expect, test } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { defineApi } from './api/builder'
import { createApiContext } from './api/context'

const notes = sqliteTable('notes', { id: text('id').primaryKey() })
const schema = { notes }

const o = defineApi({ schema })

function createContext() {
  return createApiContext<typeof schema, never>(
    {
      db: {} as never,
      env: {} as never,
      storage: {} as never,
      email: {} as never,
      jobs: {} as never,
      realtime: {} as never,
      auth: {} as never,
    },
    new Request('http://localhost/api/t'),
  )
}

/**
 * The declared error map is the documented way for an application to raise a
 * typed error. It is only usable if a message alone is enough: the code is
 * already the name of the constructor, so repeating it inside `data` is
 * ceremony that pushes applications back to a raw `ORPCError`.
 */
test('a handler raises a declared error with a message alone', async () => {
  const procedure = o.public.handler(({ errors }) => {
    throw errors.NOT_FOUND({ message: 'Note not found' })
  })

  const client = createProcedureClient(procedure, { context: createContext() })

  await expect(client(undefined)).rejects.toThrow('Note not found')
})

test('a declared error keeps its code and accepts details', async () => {
  const procedure = o.public.handler(({ errors }) => {
    throw errors.CONFLICT({
      message: 'Already running',
      data: { details: { adaptationId: 'adapt_1' } },
    })
  })

  const client = createProcedureClient(procedure, { context: createContext() })

  const error = await client(undefined).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )

  expect(error).toBeInstanceOf(ORPCError)
  const orpcError = error as ORPCError<string, unknown>
  expect(orpcError.code).toBe('CONFLICT')
  expect(orpcError.data).toEqual({
    code: 'CONFLICT',
    details: { adaptationId: 'adapt_1' },
  })
})
