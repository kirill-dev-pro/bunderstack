import { app } from './bunderstack'

/**
 * The production queue and cron worker, as its own process (`bun run worker`).
 * It is deliberately not started from the web entry: every web replica would
 * run one and they would contend for the same jobs.
 */
await app.runWorker()
