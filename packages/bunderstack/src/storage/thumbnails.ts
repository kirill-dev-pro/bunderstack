import { createHash } from 'node:crypto'

export interface TransformSpec {
  w?: number
  h?: number
  fit?: 'fill' | 'inside'
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  quality?: number
}

export async function transformImage(
  input: Buffer,
  spec: TransformSpec,
): Promise<Buffer> {
  let img = new Bun.Image(input)

  if (spec.w !== undefined && spec.h !== undefined) {
    img = img.resize(spec.w, spec.h, { fit: spec.fit ?? 'fill' })
  } else if (spec.w !== undefined) {
    img = img.resize(spec.w)
  } else if (spec.h !== undefined) {
    img = img.resize(0, spec.h)
  }

  const q = spec.quality
  switch (spec.format) {
    case 'webp':
      return img.webp({ quality: q }).buffer()
    case 'png':
      return img.png().buffer()
    case 'avif':
      return img.avif({ quality: q }).buffer()
    default:
      return img.jpeg({ quality: q }).buffer()
  }
}

export function transformHash(spec: TransformSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(spec))
    .digest('hex')
    .slice(0, 16)
}

export function parseTransformSpec(
  query: Record<string, string>,
): TransformSpec | null {
  const { w, h, fit, format, quality } = query
  if (!w && !h && !fit && !format && !quality) return null

  const spec: TransformSpec = {}
  if (w) spec.w = Number(w)
  if (h) spec.h = Number(h)
  if (fit && ['fill', 'inside'].includes(fit)) {
    spec.fit = fit as TransformSpec['fit']
  }
  if (format && ['webp', 'jpeg', 'png', 'avif'].includes(format)) {
    spec.format = format as TransformSpec['format']
  }
  if (quality) spec.quality = Math.min(100, Math.max(1, Number(quality)))
  return spec
}
