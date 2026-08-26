const ADJECTIVES = [
  'Bright',
  'Calm',
  'Gentle',
  'Kind',
  'Quiet',
  'Sunny',
  'Swift',
  'Warm',
] as const

const ANIMALS = [
  'Fox',
  'Hare',
  'Lynx',
  'Owl',
  'Otter',
  'Robin',
  'Tiger',
  'Wolf',
] as const

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.min(items.length - 1, Math.floor(random() * items.length))]!

export function generateFriendlyName(random: () => number = Math.random) {
  return `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`
}
