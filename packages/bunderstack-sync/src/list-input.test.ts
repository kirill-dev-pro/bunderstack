import { QueryClient } from '@tanstack/react-query'
import { expect, test } from 'bun:test'

import { createTableCollection } from './collection'

type Row = { id: string }

function tableWithRecordedInput() {
  const calls: Record<string, unknown>[] = []
  const procedures = {
    list: {
      call: async (input: Record<string, unknown> = {}) => {
        calls.push(input)
        return { items: [] as Row[], hasMore: false }
      },
    },
    get: { call: async () => ({ id: 'r1' }) },
    create: { call: async (value: any) => value },
    update: { call: async ({ body }: any) => body },
    delete: { call: async () => {} },
  }
  const table = createTableCollection<Row>({
    tableName: 'rows',
    procedures,
    queryClient: new QueryClient(),
  })
  return { table, calls }
}

test('list forwards the procedure input unchanged', async () => {
  const { table, calls } = tableWithRecordedInput()

  await table.table.list({ filters: { userId: 'u1' }, limit: 5 })

  expect(calls[0]).toEqual({ filters: { userId: 'u1' }, limit: 5 })
})

test('list does not invent an empty filters object', async () => {
  const { table, calls } = tableWithRecordedInput()

  await table.table.list()

  expect(calls[0]).toEqual({})
})
