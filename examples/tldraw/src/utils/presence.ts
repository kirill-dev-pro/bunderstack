import type { InferSelect } from 'bunderstack-sync'

import type * as schema from '~/schema'

export type PresenceRow = InferSelect<typeof schema.presence>

/** A peer is "online" while its heartbeat is fresher than this. */
export const PRESENCE_TTL_MS = 60_000
/** Keep our own row fresh while idle. */
export const PRESENCE_HEARTBEAT_MS = 20_000
/** Minimum gap between cursor-position writes. */
export const CURSOR_THROTTLE_MS = 120

export const PRESENCE_COLORS = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
] as const

const GUEST_ANIMALS = [
  'Fox',
  'Owl',
  'Bear',
  'Lynx',
  'Otter',
  'Hare',
  'Wolf',
  'Crane',
  'Seal',
  'Moth',
] as const

const GUEST_NAME_KEY = 'tldraw-guest-name'

type NameStore = Pick<Storage, 'getItem' | 'setItem'>

/** Stable per-browser guest name, e.g. "Guest Otter 27". */
export function getGuestName(store: NameStore): string {
  const existing = store.getItem(GUEST_NAME_KEY)
  if (existing) return existing

  const animal = GUEST_ANIMALS[Math.floor(Math.random() * GUEST_ANIMALS.length)]
  const name = `Guest ${animal} ${Math.floor(Math.random() * 90) + 10}`
  store.setItem(GUEST_NAME_KEY, name)
  return name
}

/** Deterministic cursor/avatar color for a presence id or name. */
export function presenceColor(seed: string): (typeof PRESENCE_COLORS)[number] {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length]!
}

/** Compact avatar text: "Guest Otter 27" → "GO", "Ada Lovelace" → "AL". */
export function presenceInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  const source = parts.length > 1 ? parts.slice(0, 2) : parts
  return source
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function isPresenceFresh(
  row: Pick<PresenceRow, 'updatedAt'>,
  nowMs: number,
  ttlMs = PRESENCE_TTL_MS,
): boolean {
  return nowMs - new Date(row.updatedAt).getTime() < ttlMs
}
