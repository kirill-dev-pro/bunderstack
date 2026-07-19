import { cronMatches, parseCron } from './cron'

type Timer = ReturnType<typeof setTimeout>

export type LocalCronDefinition = {
  name: string
  schedule: string
}

export type LocalCronSchedulerOptions = {
  cron: readonly LocalCronDefinition[]
  runSlot: (name: string, scheduledFor: number) => Promise<void>
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
  onError?: (error: Error) => void
}

export type LocalCronScheduler = {
  tick: () => Promise<void>
  close: () => Promise<void>
}

/**
 * Runs declared cron handlers locally. Production schedules should be delivered
 * by the hosting platform through the signed cron endpoint instead.
 */
export function startLocalCronScheduler(
  options: LocalCronSchedulerOptions,
): LocalCronScheduler {
  const cron = options.cron.map((definition) => ({
    ...definition,
    expression: parseCron(definition.schedule),
  }))
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? setTimeout
  const clearTimer = options.clearTimer ?? clearTimeout
  let timer: Timer | undefined
  let closed = false

  const scheduleNextTick = () => {
    if (closed || timer) return

    const delay = 60_000 - (now() % 60_000)
    timer = setTimer(() => {
      timer = undefined
      void tick().catch((error: unknown) => {
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        )
      })
    }, delay)
  }

  const tick = async () => {
    if (closed) return

    const scheduledFor = Math.floor(now() / 60_000) * 60_000
    for (const definition of cron) {
      if (cronMatches(definition.expression, scheduledFor)) {
        await options.runSlot(definition.name, scheduledFor)
      }
    }

    scheduleNextTick()
  }

  return {
    tick,
    async close() {
      closed = true
      if (timer) {
        clearTimer(timer)
        timer = undefined
      }
    },
  }
}
