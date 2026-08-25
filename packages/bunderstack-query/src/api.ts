import type { AnyRouter, RouterClient } from '@orpc/server'

import {
  createTanstackQueryUtils,
  type RouterUtils,
} from '@orpc/tanstack-query'
import { createRpcClient, type Fetch } from 'bunderstack-client'

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: Fetch
}

export type ApiQueryUtils<TRouter extends AnyRouter> = RouterUtils<
  RouterClient<TRouter>
>

export function createApiClient<TRouter extends AnyRouter = AnyRouter>(
  options: ApiClientOptions = {},
): ApiQueryUtils<TRouter> {
  const client = createRpcClient<TRouter>(options)
  return createTanstackQueryUtils(client as unknown as RouterClient<TRouter>)
}
