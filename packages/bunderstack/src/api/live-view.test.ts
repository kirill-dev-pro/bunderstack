import { describe, expect, test } from 'bun:test'

import { matchesLiveFilters } from './live-view'

describe('matchesLiveFilters', () => {
  test('no filters matches everything', () => {
    expect(matchesLiveFilters({ id: 'a' }, undefined)).toBe(true)
    expect(matchesLiveFilters({ id: 'a' }, {})).toBe(true)
  })

  test('a scalar is equality', () => {
    expect(matchesLiveFilters({ userId: 'u1' }, { userId: 'u1' })).toBe(true)
    expect(matchesLiveFilters({ userId: 'u2' }, { userId: 'u1' })).toBe(false)
  })

  test('an array is IN', () => {
    expect(matchesLiveFilters({ status: 'b' }, { status: ['a', 'b'] })).toBe(
      true,
    )
    expect(matchesLiveFilters({ status: 'c' }, { status: ['a', 'b'] })).toBe(
      false,
    )
  })

  test('null is IS NULL, and a missing column counts as null', () => {
    expect(matchesLiveFilters({ teamId: null }, { teamId: null })).toBe(true)
    expect(matchesLiveFilters({}, { teamId: null })).toBe(true)
    expect(matchesLiveFilters({ teamId: 't1' }, { teamId: null })).toBe(false)
  })

  test('the string form of null means the same thing', () => {
    expect(matchesLiveFilters({ teamId: null }, { teamId: 'null' })).toBe(true)
    expect(matchesLiveFilters({ teamId: 't1' }, { teamId: 'null' })).toBe(false)
  })

  test('undefined filter entries are skipped', () => {
    expect(matchesLiveFilters({ a: 1 }, { a: undefined })).toBe(true)
  })

  test('dates compare by time', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(matchesLiveFilters({ at }, { at: new Date(at.getTime()) })).toBe(
      true,
    )
    expect(matchesLiveFilters({ at }, { at: new Date(0) })).toBe(false)
  })
})
