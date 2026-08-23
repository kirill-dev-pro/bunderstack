/**
 * The SSE frames of one response body, decoded as JSON.
 *
 * A live view carries JSON in `data:` lines; keepalive comments and event
 * names never surface. Written here rather than taken from a library, so the
 * browser entry point keeps zero dependencies.
 */
/**
 * The part of a byte stream this reader uses. Stated structurally, so the DOM
 * and Bun definitions of `ReadableStream` both satisfy it without a cast.
 */
export type ByteStream = {
  getReader: () => {
    read: () => Promise<{ done: boolean; value?: Uint8Array }>
    cancel: () => Promise<unknown>
  }
}

export async function* parseSseFrames<TFrame>(
  body: ByteStream,
): AsyncGenerator<TFrame, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []

  const flush = (): TFrame | undefined => {
    if (data.length === 0) return undefined
    const frame = JSON.parse(data.join('\n')) as TFrame
    data = []
    return frame
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const frame = flush()
          if (frame !== undefined) yield frame
        } else if (line.startsWith('data:')) {
          data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
        }
      }
    }
    const frame = flush()
    if (frame !== undefined) yield frame
  } finally {
    await reader.cancel().catch(() => {})
  }
}
