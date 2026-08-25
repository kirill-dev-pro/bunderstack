import { QueryClient } from '@tanstack/solid-query'
import { createClient } from 'bunderstack/query'

import type { App } from './bunderstack'

export const queryClient = new QueryClient()

/**
 * The typed client. `createClient` reads the server's `App` type and returns
 * TanStack Query option builders for every table and procedure, so the UI
 * never writes a URL, a query key, or a fetch.
 *
 * The `App` import is type-only — no server code reaches the browser.
 */
export const api = createClient<App>({ queryClient })
