import { createWorker } from 'bunderstack/workers'

import { backend } from './bunderstack'

const worker = createWorker(backend)
export const { Scheduler, RealtimeHub, RateLimiter } = worker.durableObjects
export default worker.handler
