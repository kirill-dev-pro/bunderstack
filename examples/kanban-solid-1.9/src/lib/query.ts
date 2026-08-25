import { QueryClient } from '@tanstack/solid-query'
import { createClient } from 'bunderstack/query'

import type { App } from '../bunderstack.ts'

const baseUrl = '/api'
export const queryClient = new QueryClient()

export const api = createClient<App>({ baseUrl, queryClient, fetch })
