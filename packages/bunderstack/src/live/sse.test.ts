import { expect, test } from 'bun:test'

import { parseSseFrames } from './sse'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('frames arrive one per blank-line block, across chunk splits', async () => {
  const stream = streamOf([
    ': keepalive\n\n',
    'event: message\ndata: {"type":"heart',
    'beat","intervalMs":5000}\n\n',
    'event: message\ndata: {"type":"remove",',
    '"id":"a"}\n\nevent: close\n\n',
  ])
  const frames: unknown[] = []
  for await (const frame of parseSseFrames(stream)) frames.push(frame)
  expect(frames).toEqual([
    { type: 'heartbeat', intervalMs: 5000 },
    { type: 'remove', id: 'a' },
  ])
})

test('a multi-line data payload joins with newlines', async () => {
  const stream = streamOf(['data: {"type":"remove",\ndata: "id":"a"}\n\n'])
  const frames: unknown[] = []
  for await (const frame of parseSseFrames(stream)) frames.push(frame)
  expect(frames).toEqual([{ type: 'remove', id: 'a' }])
})

test('a last frame without a trailing blank line still arrives', async () => {
  const stream = streamOf(['data: {"type":"remove","id":"a"}\n'])
  const frames: unknown[] = []
  for await (const frame of parseSseFrames(stream)) frames.push(frame)
  expect(frames).toEqual([{ type: 'remove', id: 'a' }])
})
