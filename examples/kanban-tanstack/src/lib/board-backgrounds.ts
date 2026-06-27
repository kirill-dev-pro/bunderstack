export const BOARD_BACKGROUNDS = [
  'blue',
  'green',
  'purple',
  'orange',
  'red',
  'pink',
  'teal',
  'slate',
] as const

export type BoardBackground = (typeof BOARD_BACKGROUNDS)[number]

export function boardBackgroundClass(bg: string | null | undefined) {
  const key = BOARD_BACKGROUNDS.includes(bg as BoardBackground) ? bg : 'blue'
  return `board-bg-${key}`
}

export function boardTileClass(boardId: string, bg: string | null | undefined) {
  if (bg && BOARD_BACKGROUNDS.includes(bg as BoardBackground)) {
    return `board-tile-bg-${bg}`
  }
  const hash = boardId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return `board-tile-bg-${BOARD_BACKGROUNDS[hash % BOARD_BACKGROUNDS.length]}`
}
