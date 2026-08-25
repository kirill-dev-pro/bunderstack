import type { StandardUrl } from '@orpc/client/standard'
import type { AnyRouter, RouterClient } from '@orpc/server'

import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'

export const OPERATION_ID_HEADER = 'x-bunderstack-operation-id'

export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export type ClientOptions = {
  baseUrl?: string
  fetch?: Fetch
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
}

export type CallOptions = {
  signal?: AbortSignal
  lastEventId?: string
  operationId?: string
  headers?: HeadersInit
}

export type ClientCarrier = {
  api: AnyRouter
  buckets: string
}

export type AnyBunderstackApp = {
  $inferClient?: ClientCarrier | undefined
}

export type InferApiRouter<TApp extends AnyBunderstackApp> = NonNullable<
  TApp['$inferClient']
>['api']

type RpcContext = {
  operationId?: string
  headers?: HeadersInit
}

type AdaptCallArgs<TArgs extends unknown[]> = {
  [K in keyof TArgs]: K extends 1 | '1' ? CallOptions : TArgs[K]
}

export type DirectClient<T> = T extends (...args: infer TArgs) => infer TResult
  ? (...args: AdaptCallArgs<TArgs>) => TResult
  : { [K in keyof T]: DirectClient<T[K]> }

export type RpcClient<TRouter extends AnyRouter> = DirectClient<
  RouterClient<TRouter, RpcContext>
>

export type BunderstackClient<TApp extends AnyBunderstackApp> = RpcClient<
  InferApiRouter<TApp>
>

function rpcUrl(baseUrl = '/api'): StandardUrl {
  return (
    baseUrl.endsWith('/') ? `${baseUrl}rpc` : `${baseUrl}/rpc`
  ) as StandardUrl
}

function adaptClient<T>(client: T): DirectClient<T> {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(function () {} as (...args: unknown[]) => unknown, {
    get(_target, property) {
      if (!cache.has(property)) {
        const value = Reflect.get(client as object, property)
        cache.set(
          property,
          value === null ||
            (typeof value !== 'object' && typeof value !== 'function')
            ? value
            : adaptClient(value),
        )
      }
      return cache.get(property)
    },
    apply(_target, _thisArg, args: [unknown, CallOptions?]) {
      const [input, options = {}] = args
      return Reflect.apply(
        client as (...args: unknown[]) => unknown,
        undefined,
        [
          input,
          {
            signal: options.signal,
            lastEventId: options.lastEventId,
            context: {
              operationId: options.operationId,
              headers: options.headers,
            },
          },
        ],
      )
    },
  }) as unknown as DirectClient<T>
}

export function createRpcClient<TRouter extends AnyRouter>(
  options: ClientOptions = {},
): RpcClient<TRouter> {
  const fetcher =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const link = new RPCLink<RpcContext>({
    url: rpcUrl(options.baseUrl),
    fetch: (url, init) => fetcher(url, init),
    headers: async ({ context }) => {
      const defaults =
        typeof options.headers === 'function'
          ? await options.headers()
          : options.headers
      const headers = new Headers(defaults)
      new Headers(context.headers).forEach((value, key) =>
        headers.set(key, value),
      )
      if (context.operationId) {
        headers.set(OPERATION_ID_HEADER, context.operationId)
      }
      return headers
    },
  })
  const client = createORPCClient<RouterClient<TRouter, RpcContext>>(link)
  return adaptClient(client)
}

export function createClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): BunderstackClient<TApp> {
  return createRpcClient<InferApiRouter<TApp>>(options)
}
