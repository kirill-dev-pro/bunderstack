import { bunderstackStart } from 'bunderstack-start'

import type { App } from './bunderstack'

// Everything else — tables, buckets, SSR-aware fetch, realtime — is
// inferred from the server app type.
export const { createQueryClient, createApi } = bunderstackStart<App>()

export type AppApi = ReturnType<typeof createApi>
