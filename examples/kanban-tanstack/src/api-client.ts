import { QueryClient } from '@tanstack/react-query'
import { createIsomorphicFn } from '@tanstack/react-start'
import { createBunderstackQueryClient } from 'bunderstack-query'

import type * as schema from './schema'

const isomorphicFetch = createIsomorphicFn()
  .client((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: 'include' }),
  )
  .server(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      const { getRequest } = await import('@tanstack/react-start/server')
      const incoming = getRequest()
      const origin = new URL(incoming.url).origin
      const headers = new Headers(init?.headers)
      const cookie = incoming.headers.get('cookie')
      if (cookie) headers.set('cookie', cookie)
      return fetch(new URL(input, origin), { ...init, headers })
    }
    return fetch(input, init)
  })

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
})

export const listParams = { limit: 100, offset: 0 } as const

const apiBuilder = createBunderstackQueryClient<typeof schema>()

export const api = apiBuilder.with({
  queryClient,
  fetch: isomorphicFetch,
  tables: [
    'boards',
    'lists',
    'cards',
    'comments',
    'activity',
    'attachments',
    'reactions',
    'user',
  ] as const,
  buckets: ['attachments', 'avatars'] as const,
})
