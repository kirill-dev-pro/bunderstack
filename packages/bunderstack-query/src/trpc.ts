import type { AnyRouter } from '@trpc/server'
import type { TRPCOptionsProxy } from '@trpc/tanstack-react-query'

import { QueryClient } from '@tanstack/react-query'
import {
  createTRPCClient as _createTRPCClient,
  httpBatchLink,
} from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import superjson from 'superjson'

import type { AnyBunderstackApp, InferTrpcRouter } from './infer'

import {
  createClient,
  type ClientOptions,
  type RestBunderstackClient,
} from './client'

export type TRPCBunderstackClient<TApp extends AnyBunderstackApp> =
  RestBunderstackClient<TApp> & {
    trpc: TRPCOptionsProxy<
      InferTrpcRouter<TApp> extends AnyRouter
        ? InferTrpcRouter<TApp>
        : AnyRouter
    >
  }

function createTRPCClientTransport(options: ClientOptions) {
  const baseUrl = options.baseUrl ?? '/api'
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
  return _createTRPCClient<AnyRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        transformer: superjson,
        fetch: fetchFn,
      }),
    ],
  })
}

export function createTRPCClient<TApp extends AnyBunderstackApp>(
  options: ClientOptions = {},
): TRPCBunderstackClient<TApp> {
  const rest = createClient<TApp>(options)
  let trpcProxy: any
  return new Proxy(rest, {
    get(target, property, receiver) {
      if (property !== 'trpc') return Reflect.get(target, property, receiver)
      trpcProxy ??= createTRPCOptionsProxy({
        client: createTRPCClientTransport(options),
        queryClient: options.queryClient ?? new QueryClient(),
      })
      return trpcProxy
    },
  }) as TRPCBunderstackClient<TApp>
}
