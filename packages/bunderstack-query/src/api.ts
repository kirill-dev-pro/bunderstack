import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { StandardUrl } from '@orpc/client/standard'
import type { AnyRouter, RouterClient } from '@orpc/server'
import {
  createTanstackQueryUtils,
  type RouterUtils,
} from '@orpc/tanstack-query'

import { createFetch, type RequestFetch } from './fetch'

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: RequestFetch
}

export type ApiQueryUtils<TRouter extends AnyRouter> = RouterUtils<
  RouterClient<TRouter>
>

export function createApiClient<TRouter extends AnyRouter = AnyRouter>(
  options: ApiClientOptions = {},
): ApiQueryUtils<TRouter> {
  const baseUrl = options.baseUrl ?? '/api'
  const fetch = createFetch(options.fetch)

  const rpcUrl = baseUrl.endsWith('/') ? `${baseUrl}rpc` : `${baseUrl}/rpc`

  const link = new RPCLink({
    url: rpcUrl as StandardUrl,
    fetch,
  })

  const client = createORPCClient<RouterClient<TRouter>>(link)
  return createTanstackQueryUtils(client) as unknown as ApiQueryUtils<TRouter>
}
