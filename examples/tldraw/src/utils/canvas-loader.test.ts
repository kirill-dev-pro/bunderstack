import { expect, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'

import { buildCanvasFetchRequest } from './canvas-loader'

test('buildCanvasFetchRequest fetches the canvas API with current headers', () => {
  const id = generateTypeId('canvas')
  const request = new Request('https://example.test/canvas/abc', {
    headers: {
      cookie: 'session=abc',
      'x-forwarded-host': 'example.test',
    },
  })

  const next = buildCanvasFetchRequest(request, id)

  expect(next.url).toBe(`https://example.test/api/canvas/${id}`)
  expect(next.headers.get('cookie')).toBe('session=abc')
  expect(next.headers.get('x-forwarded-host')).toBe('example.test')
})
