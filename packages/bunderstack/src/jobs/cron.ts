// src/jobs/cron.ts — minimal 5-field cron parser, UTC, minute granularity.
// Supports: * , lists (a,b) , ranges (a-b) , steps (*/n, a-b/n, a/n). No
// month/day names, no seconds field, no @-shortcuts — YAGNI for v1.

export type CronField = { any: boolean; values: ReadonlySet<number> }

export type ParsedCron = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

const PART_RE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/

function parseField(
  spec: string,
  min: number,
  max: number,
  expr: string,
): CronField {
  if (spec === '*') return { any: true, values: new Set() }
  const values = new Set<number>()
  for (const part of spec.split(',')) {
    const m = PART_RE.exec(part)
    if (!m) throw new Error(`[bunderstack] invalid cron "${expr}": "${part}"`)
    const step = m[2] !== undefined ? Number(m[2]) : 1
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = min
      hi = max
    } else if (m[1]!.includes('-')) {
      const [a, b] = m[1]!.split('-')
      lo = Number(a)
      hi = Number(b)
    } else {
      lo = Number(m[1])
      // "5/15" means "starting at 5, every 15" per cron convention.
      hi = step > 1 ? max : lo
    }
    if (step < 1 || lo < min || hi > max || lo > hi) {
      throw new Error(`[bunderstack] invalid cron "${expr}": "${part}"`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { any: false, values }
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `[bunderstack] invalid cron "${expr}": expected 5 fields (minute hour day-of-month month day-of-week)`,
    )
  }
  const dow = parseField(parts[4]!, 0, 7, expr)
  return {
    minute: parseField(parts[0]!, 0, 59, expr),
    hour: parseField(parts[1]!, 0, 23, expr),
    dayOfMonth: parseField(parts[2]!, 1, 31, expr),
    month: parseField(parts[3]!, 1, 12, expr),
    // 7 is an alias for Sunday (0).
    dayOfWeek: dow.any
      ? dow
      : { any: false, values: new Set([...dow.values].map((v) => v % 7)) },
  }
}

function inField(field: CronField, value: number): boolean {
  return field.any || field.values.has(value)
}

/** Whether the minute containing `epochMs` matches, evaluated in UTC. */
export function cronMatches(cron: ParsedCron, epochMs: number): boolean {
  const d = new Date(epochMs)
  if (!inField(cron.minute, d.getUTCMinutes())) return false
  if (!inField(cron.hour, d.getUTCHours())) return false
  if (!inField(cron.month, d.getUTCMonth() + 1)) return false
  const domOk = inField(cron.dayOfMonth, d.getUTCDate())
  const dowOk = inField(cron.dayOfWeek, d.getUTCDay())
  // Standard cron rule: when BOTH day fields are restricted, either may match.
  return !cron.dayOfMonth.any && !cron.dayOfWeek.any
    ? domOk || dowOk
    : domOk && dowOk
}
