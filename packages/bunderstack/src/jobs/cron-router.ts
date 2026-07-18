import { Hono } from 'hono'

import type { AnyDb } from '../dialect'
import type { BackgroundDefs } from './define'

import { verifyScheduleRequest } from './cron-auth'
import { runCronSlot } from './cron-runner'

const MAX_SLOT_AGE_MS = 60 * 60_000
const MAX_FUTURE_SLOT_MS = 60_000

export function buildCronRouter(args: {
  db: AnyDb
  defs: BackgroundDefs
  ctx: Record<string, unknown>
  secret: string
  storage: { sweep: () => Promise<unknown> }
  now?: () => number
}): Hono {
  const app = new Hono()
  const now = args.now ?? Date.now

  app.post('/:name', async (c) => {
    const name = c.req.param('name')
    const slotText = c.req.header('X-Bunderstack-Cron-Slot')
    const signature = c.req.header('X-Bunderstack-Cron-Signature')
    const slot = Number(slotText)
    if (!slotText || !Number.isSafeInteger(slot) || !signature) {
      return c.json({ error: 'invalid schedule signature' }, 401)
    }
    if (!verifyScheduleRequest(args.secret, `cron:${name}`, slot, signature)) {
      return c.json({ error: 'invalid schedule signature' }, 401)
    }
    const definition = args.defs[name]
    if (!definition || definition.kind !== 'cron') {
      return c.json({ error: 'unknown cron' }, 404)
    }
    const current = now()
    if (
      slot % 60_000 !== 0 ||
      slot < current - MAX_SLOT_AGE_MS ||
      slot > current + MAX_FUTURE_SLOT_MS
    ) {
      return c.json({ error: 'invalid cron slot' }, 400)
    }
    try {
      const result = await runCronSlot({
        db: args.db,
        defs: args.defs,
        ctx: args.ctx,
        name,
        slot,
        now: current,
      })
      return c.json(
        result,
        result.status === 'running' ? 202 : 200,
      )
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === '[bunderstack] cron slot does not match its schedule'
      ) {
        return c.json({ error: 'invalid cron slot' }, 400)
      }
      return c.json({ error: 'cron handler failed' }, 500)
    }
  })

  return app
}
