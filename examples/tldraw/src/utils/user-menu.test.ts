// @ts-nocheck

import { expect, test } from 'bun:test'

import { getUserInitials, getUserLabel } from './user-menu'

test('getUserLabel prefers name and falls back to email', () => {
  expect(getUserLabel({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBe(
    'Ada Lovelace',
  )
  expect(getUserLabel({ name: '', email: 'ada@example.com' })).toBe(
    'ada@example.com',
  )
})

test('getUserInitials creates compact avatar text', () => {
  expect(
    getUserInitials({ name: 'Ada Lovelace', email: 'ada@example.com' }),
  ).toBe('AL')
  expect(getUserInitials({ name: '', email: 'ada@example.com' })).toBe('A')
})
