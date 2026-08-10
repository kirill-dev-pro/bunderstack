import type { AnyRouter, RouterClient } from '@orpc/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import {
  createTanstackQueryUtils,
  type RouterUtils,
} from '@orpc/tanstack-query'

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: (input: any, init?: any) => Promise<Response>
}

export type ApiQueryUtils<TRouter extends AnyRouter> = RouterUtils<
  RouterClient<TRouter>
>

export function createApiClient<TRouter extends AnyRouter = AnyRouter>(
  options: ApiClientOptions = {},
): ApiQueryUtils<TRouter> {
  const baseUrl = options.baseUrl ?? '/api'
  const userFetch = options.fetch

  const fetchFn = userFetch
    ? (input: RequestInfo | URL, init?: RequestInit) => {
        const req =
          input instanceof Request
            ? input
            : new Request(input.toString(), init)
        return userFetch(req)
      }
    : globalThis.fetch.bind(globalThis)

  const rpcUrl = baseUrl.endsWith('/') ? `${baseUrl}rpc` : `${baseUrl}/rpc`

  const link = new RPCLink({
    url: rpcUrl as any,
    fetch: fetchFn as any,
  })

  const client = createORPCClient<RouterClient<TRouter>>(link as any)
  return createTanstackQueryUtils(client) as unknown as ApiQueryUtils<TRouter>
}

