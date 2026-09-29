// bunderstack/workers/entry — the Worker of an SPA. The app backend comes from
// the Vite virtual module that bunderstack() resolves.
import { backend } from 'virtual:bunderstack/backend'

import { createWorker } from './index'

const worker = createWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
