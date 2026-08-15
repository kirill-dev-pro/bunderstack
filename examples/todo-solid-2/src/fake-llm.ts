/**
 * A stand-in for a streaming model.
 *
 * What this example demonstrates is what happens to a token *after* it exists
 * — how it reaches the browser — not where it came from. Generating words
 * locally keeps the example runnable with no API key, no network, and no
 * dependency, while producing the same bursty sub-second event pattern a real
 * model would.
 */
export const VOCABULARY = [
  'blocked',
  'decision',
  'draft',
  'estimate',
  'follow-up',
  'high-value',
  'low-effort',
  'needs',
  'quick',
  'review',
  'rough',
  'scope',
  'ship',
  'team',
  'waiting',
  'week',
] as const

/** One generated token. */
export function randomWord(): string {
  return VOCABULARY[Math.floor(Math.random() * VOCABULARY.length)]!
}

/** How many tokens this summary runs to. */
export function summaryLength(): number {
  return 4 + Math.floor(Math.random() * 7)
}

/** Milliseconds to wait before the next token. */
export function tokenDelay(): number {
  return 40 + Math.floor(Math.random() * 161)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
