import { bunderstackStart } from 'bunderstack-start'

import type { App } from './bunderstack'

export const { createQueryClient, createApi } = bunderstackStart<App>()
export type SyncApi = ReturnType<typeof createApi>
