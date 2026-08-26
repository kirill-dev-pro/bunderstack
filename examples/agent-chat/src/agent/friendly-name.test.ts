import { describe, expect, test } from 'bun:test'

import { generateFriendlyName } from './friendly-name'

describe('friendly anonymous names', () => {
  test('selects readable adjective and animal words from an injected random source', () => {
    const values = [0.25, 0.5]
    expect(generateFriendlyName(() => values.shift()!)).toBe('Gentle Otter')
  })

  test('covers the lower and upper selection boundaries', () => {
    expect(generateFriendlyName(() => 0)).toBe('Bright Fox')
    expect(generateFriendlyName(() => 0.999999)).toBe('Warm Wolf')
  })
})
