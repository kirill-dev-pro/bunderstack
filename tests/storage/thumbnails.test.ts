// tests/storage/thumbnails.test.ts
import { test, expect } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { transformImage, transformHash, parseTransformSpec } from '../../src/storage/thumbnails'

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeTestImage(width = 200, height = 200): Buffer {
  const rowSize = 1 + width * 3
  const raw = Buffer.alloc(height * rowSize)
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      raw[y * rowSize + 1 + x * 3] = 100
      raw[y * rowSize + 1 + x * 3 + 1] = 150
      raw[y * rowSize + 1 + x * 3 + 2] = 200
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('transformImage resizes image to target dimensions', async () => {
  const input = makeTestImage(200, 200)
  const output = await transformImage(input, { w: 50, h: 50, fit: 'fill' })
  const meta = await new Bun.Image(output).metadata()
  expect(meta.width).toBe(50)
  expect(meta.height).toBe(50)
})

test('transformImage converts to webp when format=webp', async () => {
  const input = makeTestImage(100, 100)
  const output = await transformImage(input, { format: 'webp' })
  const meta = await new Bun.Image(output).metadata()
  expect(meta.format).toBe('webp')
})

test('transformImage returns buffer of smaller size after resize+compress', async () => {
  const input = makeTestImage(1000, 1000)
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
