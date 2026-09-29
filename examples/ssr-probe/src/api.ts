import { bunderstackStart } from 'bunderstack/start'

import type { App } from './bunderstack'

export const { createQueryClient, createApi } = bunderstackStart<App>()
export const queryClient = createQueryClient()
export const api = createApi(queryClient)
