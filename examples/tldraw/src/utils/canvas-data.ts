import type { TypeId } from 'bunderstack/typeid'
import type { InferSelect } from 'bunderstack-sync'

import type * as schema from '~/schema'

export type CanvasRow = InferSelect<typeof schema.canvas>
export type ShapeRow = InferSelect<typeof schema.shape>
export type ShapeType = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'image'

export const SHAPE_TOOLS = [
  { type: 'rectangle', label: 'Rectangle' },
  { type: 'ellipse', label: 'Ellipse' },
  { type: 'diamond', label: 'Diamond' },
  { type: 'text', label: 'Text' },
  { type: 'image', label: 'Image' },
] as const satisfies readonly { type: ShapeType; label: string }[]

const TYPE_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export const canvasListParams = (ownerId: TypeId<'user'>) =>
  ({
    ownerId,
    sort: 'updatedAt',
    order: 'desc',
    limit: 50,
  }) as const

export const shapeListParams = (canvasId: TypeId<'canvas'> | string) =>
  ({
    canvasId,
    sort: 'createdAt',
    order: 'asc',
    limit: 200,
  }) as const

export function formatCanvasDate(value: Date | string | number | null | undefined) {
  if (!value) return 'Recently'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

export function createShapeDraft(
  type: ShapeType,
  point: { x: number; y: number },
  color: string,
  options: {
    text?: string
    imageFileId?: string
    imageName?: string
  } = {},
) {
  const size = shapeSize(type)

  return {
    type,
    x: Math.round(point.x - size.width / 2),
    y: Math.round(point.y - size.height / 2),
    width: size.width,
    height: size.height,
    rotation: 0,
    color,
    text: type === 'text' ? options.text?.trim() || 'Double-click to edit' : null,
    imageFileId: type === 'image' ? options.imageFileId ?? null : null,
    imageName: type === 'image' ? options.imageName ?? null : null,
  }
}

export function createClientTypeId<P extends string>(prefix: P): TypeId<P> {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(
    bytes,
    (byte) => TYPE_ID_ALPHABET[byte % TYPE_ID_ALPHABET.length],
  ).join('')

  return `${prefix}_${suffix}` as TypeId<P>
}

function shapeSize(type: ShapeType) {
  switch (type) {
    case 'diamond':
      return { width: 140, height: 140 }
    case 'text':
      return { width: 220, height: 88 }
    case 'image':
      return { width: 240, height: 160 }
    default:
      return { width: 160, height: 96 }
  }
}
