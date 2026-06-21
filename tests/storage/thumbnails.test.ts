// tests/storage/thumbnails.test.ts
import { test, expect } from 'bun:test'
import sharp from 'sharp'
import { transformImage, transformHash, parseTransformSpec } from '../../src/storage/thumbnails'

async function makeTestImage(width = 200, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 100, g: 150, b: 200 } },
  })
    .png()
    .toBuffer()
}

test('transformImage resizes image to target dimensions', async () => {
  const input = await makeTestImage(200, 200)
  const output = await transformImage(input, { w: 50, h: 50, fit: 'cover' })
  const meta = await sharp(output).metadata()
  expect(meta.width).toBe(50)
  expect(meta.height).toBe(50)
})

test('transformImage converts to webp when format=webp', async () => {
  const input = await makeTestImage(100, 100)
  const output = await transformImage(input, { format: 'webp' })
  const meta = await sharp(output).metadata()
  expect(meta.format).toBe('webp')
})

test('transformImage returns buffer of smaller size after resize+compress', async () => {
  const input = await makeTestImage(1000, 1000)
  const output = await transformImage(input, { w: 100, h: 100, format: 'webp', quality: 60 })
  expect(output.byteLength).toBeLessThan(input.byteLength)
})

test('transformHash produces consistent 16-char hex string', () => {
  const h1 = transformHash({ w: 100, h: 100, format: 'webp' })
  const h2 = transformHash({ w: 100, h: 100, format: 'webp' })
  expect(h1).toBe(h2)
  expect(h1).toHaveLength(16)
  expect(/^[0-9a-f]+$/.test(h1)).toBe(true)
})

test('transformHash differs for different specs', () => {
  const h1 = transformHash({ w: 100 })
  const h2 = transformHash({ w: 200 })
  expect(h1).not.toBe(h2)
})

test('parseTransformSpec returns null when no transform params', () => {
  expect(parseTransformSpec({})).toBeNull()
  expect(parseTransformSpec({ foo: 'bar' })).toBeNull()
})

test('parseTransformSpec parses width and height', () => {
  const spec = parseTransformSpec({ w: '100', h: '200' })
  expect(spec).not.toBeNull()
  expect(spec?.w).toBe(100)
  expect(spec?.h).toBe(200)
})
