import { test, expect, describe } from 'bun:test'

import { shouldPublish } from './publish-changed'

describe('shouldPublish', () => {
  test('publishes when local is ahead of registry', () => {
    expect(shouldPublish('0.2.0', '0.1.0')).toBe(true)
    expect(shouldPublish('0.1.1', '0.1.0')).toBe(true)
    expect(shouldPublish('1.0.0', '0.9.9')).toBe(true)
  })

  test('skips when versions are equal', () => {
    expect(shouldPublish('0.1.0', '0.1.0')).toBe(false)
  })

  test('skips when registry is ahead of local', () => {
    expect(shouldPublish('0.1.0', '0.2.0')).toBe(false)
  })
})
