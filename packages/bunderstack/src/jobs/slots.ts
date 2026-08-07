// src/jobs/slots.ts — cron slot enumeration. Pure; no db, no clock reads.
import { cronMatches, type ParsedCron } from './cron'

/** Slot granularity. Every slot timestamp satisfies `slot % SLOT_MS === 0`. */
export const SLOT_MS = 60_000

/** Reserved job-type prefix for cron occurrences. */
export const CRON_PREFIX = 'cron:'

/** How far back either catch-up mode will look. */
export const DEFAULT_CATCH_UP_WINDOW_MS = 60 * SLOT_MS

export type CatchUp = 'latest' | 'all'

/** Aligns `ms` down to its containing slot. */
export function floorSlot(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS
}

/**
 * Slots matching `cron` in the half-open range `(from, to]`, oldest first.
 *
 * `from` is exclusive so a stored watermark is never re-emitted. Both modes are
 * clamped to `catchUpWindowMs` — without it a watermark far in the past would
 * make this iterate unbounded minutes.
 */
export function slotsDue(args: {
  cron: ParsedCron
  from: number
  to: number
  catchUp?: CatchUp
  catchUpWindowMs?: number
}): number[] {
  const catchUp = args.catchUp ?? 'latest'
  const windowMs = args.catchUpWindowMs ?? DEFAULT_CATCH_UP_WINDOW_MS
  const to = floorSlot(args.to)
  const from = Math.max(floorSlot(args.from), to - windowMs)
  if (to <= from) return []

  if (catchUp === 'latest') {
    for (let s = to; s > from; s -= SLOT_MS) {
      if (cronMatches(args.cron, s)) return [s]
    }
    return []
  }

  const slots: number[] = []
  for (let s = from + SLOT_MS; s <= to; s += SLOT_MS) {
    if (cronMatches(args.cron, s)) slots.push(s)
  }
  return slots
}
