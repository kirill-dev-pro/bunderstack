export interface RevisionedMessage {
  id: string
  content: string
  revision: number
}

export function mergeRevisionedMessage<T extends RevisionedMessage>(
  current: T,
  incoming: T,
): T {
  if (current.id !== incoming.id) return incoming
  return incoming.revision > current.revision ? incoming : current
}

export function nextTextFrame(
  current: string,
  target: string,
  charactersPerFrame = 18,
): string {
  if (!target.startsWith(current)) return target
  if (current.length >= target.length) return target
  return target.slice(0, current.length + charactersPerFrame)
}
