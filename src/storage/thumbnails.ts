// src/storage/thumbnails.ts
import sharp from 'sharp'
import { createHash } from 'node:crypto'

export interface TransformSpec {
  w?: number
  h?: number
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside'
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  quality?: number
}

export async function transformImage(input: Buffer, spec: TransformSpec): Promise<Buffer> {
  let pipeline = sharp(input)

  if (spec.w !== undefined || spec.h !== undefined) {
    pipeline = pipeline.resize(spec.w, spec.h, { fit: spec.fit ?? 'cover' })
  }

  if (spec.format) {
    pipeline = pipeline.toFormat(spec.format, { quality: spec.quality })
  } else if (spec.quality) {
    pipeline = pipeline.jpeg({ quality: spec.quality })
  }

  return pipeline.toBuffer()
}

export function transformHash(spec: TransformSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16)
}

export function parseTransformSpec(query: Record<string, string>): TransformSpec | null {
  const { w, h, fit, format, quality } = query
  if (!w && !h && !fit && !format && !quality) return null

  const spec: TransformSpec = {}
  if (w) spec.w = Number(w)
  if (h) spec.h = Number(h)
  if (fit && ['cover', 'contain', 'fill', 'inside', 'outside'].includes(fit)) {
    spec.fit = fit as TransformSpec['fit']
  }
  if (format && ['webp', 'jpeg', 'png', 'avif'].includes(format)) {
    spec.format = format as TransformSpec['format']
  }
  if (quality) spec.quality = Math.min(100, Math.max(1, Number(quality)))
  return spec
}
