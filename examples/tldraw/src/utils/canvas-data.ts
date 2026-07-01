import type { TypeId } from 'bunderstack/typeid'
import type { InferSelect } from 'bunderstack-sync'

import type * as schema from '~/schema'

export type CanvasRow = InferSelect<typeof schema.canvas>
export type ShapeRow = InferSelect<typeof schema.shape>

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

export function createClientTypeId<P extends string>(prefix: P): TypeId<P> {
  const bytes = new Uint8Array(26)
  crypto.getRandomValues(bytes)
  const suffix = Array.from(
    bytes,
    (byte) => TYPE_ID_ALPHABET[byte % TYPE_ID_ALPHABET.length],
  ).join('')

  return `${prefix}_${suffix}` as TypeId<P>
}
