// @ts-nocheck

import { expect, test } from 'bun:test'

import {
  PRESENCE_COLORS,
  getGuestName,
  isPresenceFresh,
  presenceColor,
  presenceInitials,
} from './presence'

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

test('getGuestName mints a name once and then reuses it', () => {
  const store = memoryStore()
  const first = getGuestName(store)
  expect(first).toMatch(/^Guest \w+ \d{2}$/)
  expect(getGuestName(store)).toBe(first)
})

test('presenceColor is deterministic and stays in the palette', () => {
  const color = presenceColor('presence_abc123')
  expect(presenceColor('presence_abc123')).toBe(color)
  expect(PRESENCE_COLORS).toContain(color)
})

test('presenceInitials creates compact avatar text', () => {
  expect(presenceInitials('Guest Otter 27')).toBe('GO')
  expect(presenceInitials('Ada Lovelace')).toBe('AL')
  expect(presenceInitials('ada')).toBe('A')
})

test('isPresenceFresh cuts off at the ttl', () => {
  const now = Date.now()
  expect(isPresenceFresh({ updatedAt: new Date(now - 1_000) }, now)).toBe(true)
  expect(isPresenceFresh({ updatedAt: new Date(now - 61_000) }, now)).toBe(
    false,
  )
})
