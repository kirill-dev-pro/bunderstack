import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export function createApiClient<TRouter = any>(
  options: ApiClientOptions = {},
) {
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

  const client = createORPCClient<any>(link as any)
  return createTanstackQueryUtils(client as any) as any
}
