import { QueryClient } from '@tanstack/solid-query'
import { createTableClient } from 'bunderstack-query'

const baseUrl = '/api'
export const queryClient = new QueryClient()

const tables = ['boards', 'lists', 'cards', 'comments', 'activity'] as const
export type TableName = (typeof tables)[number]

export const tableClients = Object.fromEntries(
  tables.map((t) => [t, createTableClient({ tableName: t, baseUrl, fetch })]),
) as Record<TableName, ReturnType<typeof createTableClient>>
