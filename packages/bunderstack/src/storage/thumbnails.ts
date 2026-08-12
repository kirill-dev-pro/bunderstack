import { createHash } from 'node:crypto'

export interface TransformSpec {
  w?: number
  h?: number
  fit?: 'fill' | 'inside'
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  quality?: number
}

/**
 * `Bun.Image` is newer than some `bun-types` releases, and this file is shipped
 * as source — typing it against the ambient `Bun` namespace turns a consumer's
 * older types into a compile error in their build. Declaring the slice we use
 * keeps this file compiling on any `bun-types`, and the runtime check reports a
 * too-old Bun instead of `undefined is not a constructor`.
 */
interface BunImage {
  resize(
    width: number,
    height?: number,
    options?: { fit?: 'fill' | 'inside' },
  ): BunImage
  webp(options?: { quality?: number }): { buffer(): Promise<Buffer> }
  jpeg(options?: { quality?: number }): { buffer(): Promise<Buffer> }
  png(): { buffer(): Promise<Buffer> }
  avif(options?: { quality?: number }): { buffer(): Promise<Buffer> }
}

type BunImageConstructor = new (input: Buffer) => BunImage

function imageConstructor(): BunImageConstructor {
  const ctor = (Bun as unknown as { Image?: BunImageConstructor }).Image
  if (!ctor) {
    throw new Error(
      '[bunderstack] image transforms need Bun.Image — upgrade Bun (>= 1.3) or request the original file without transform params',
    )
  }
  return ctor
}

export async function transformImage(
  input: Buffer,
  spec: TransformSpec,
): Promise<Buffer> {
  const Image = imageConstructor()
  let img = new Image(input)

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
  if (fit === 'fill' || fit === 'inside') spec.fit = fit
  if (
    format === 'webp' ||
    format === 'jpeg' ||
    format === 'png' ||
    format === 'avif'
  ) {
    spec.format = format
  }
  if (quality) spec.quality = Math.min(100, Math.max(1, Number(quality)))
  return spec
}
