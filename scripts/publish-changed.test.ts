import { test, expect, describe } from 'bun:test'

import { distTagForVersion, shouldPublish } from './publish-changed'

describe('shouldPublish', () => {
  test('publishes when local is ahead of registry', () => {
    expect(shouldPublish('0.2.0', '0.1.0')).toBe(true)
    expect(shouldPublish('0.1.1', '0.1.0')).toBe(true)
    expect(shouldPublish('1.0.0', '0.9.9')).toBe(true)
    expect(shouldPublish('1.0.0-beta.1', '0.25.2')).toBe(true)
    expect(shouldPublish('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
  })

  test('skips when versions are equal', () => {
    expect(shouldPublish('0.1.0', '0.1.0')).toBe(false)
    expect(shouldPublish('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false)
  })

  test('skips when registry is ahead of local', () => {
    expect(shouldPublish('0.1.0', '0.2.0')).toBe(false)
  })
})

describe('distTagForVersion', () => {
  test('selects latest for stable releases and tag prefix for prereleases', () => {
    expect(distTagForVersion('1.0.0')).toBe('latest')
    expect(distTagForVersion('1.0.0-beta.1')).toBe('beta')
    expect(distTagForVersion('1.0.0-next.0')).toBe('next')
  })
})
