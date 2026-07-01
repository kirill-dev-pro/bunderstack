import { bunderstackStart } from 'bunderstack-start'

import type { App } from './bunderstack'

// Everything else — tables, buckets, SSR-aware fetch, realtime — is
// inferred from the server app type. See PLAN.md "progressive disclosure".
//
// NOTE: don't name this file `client.ts` — that's a reserved TanStack Start
// entry-point name; it would silently replace the framework's hydration
// entry and render the app inert in the browser.
export const { createQueryClient, createApi } = bunderstackStart<App>()

export type SyncApi = ReturnType<typeof createApi>
