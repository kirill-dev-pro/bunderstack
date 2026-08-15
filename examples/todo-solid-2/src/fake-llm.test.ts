import { expect, test } from 'bun:test'

import { randomWord, summaryLength, tokenDelay, VOCABULARY } from './fake-llm'

test('randomWord only ever returns a vocabulary entry', () => {
  for (let i = 0; i < 200; i++) {
    // `as const` narrows VOCABULARY to a literal union, which `toContain`
    // would then demand of its argument; randomWord returns a plain string.
    expect(VOCABULARY as readonly string[]).toContain(randomWord())
  }
})

test('summaryLength stays within 4 and 10 inclusive', () => {
  const seen = new Set<number>()
  for (let i = 0; i < 500; i++) {
    const n = summaryLength()
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(4)
    expect(n).toBeLessThanOrEqual(10)
    seen.add(n)
  }
  // A constant would pass the bounds check above, so assert it actually varies.
  expect(seen.size).toBeGreaterThan(1)
})

test('tokenDelay stays within 40 and 200 inclusive', () => {
  for (let i = 0; i < 500; i++) {
    const ms = tokenDelay()
    expect(ms).toBeGreaterThanOrEqual(40)
    expect(ms).toBeLessThanOrEqual(200)
  }
})
