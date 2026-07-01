import { expect, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'

import { canvasListParams, createClientTypeId, shapeListParams } from './canvas-data'

test('canvasListParams sorts the current user canvases by recent updates', () => {
  const ownerId = generateTypeId('user')

  expect(canvasListParams(ownerId)).toEqual({
    ownerId,
    sort: 'updatedAt',
    order: 'desc',
    limit: 50,
  })
})

test('shapeListParams scopes whiteboard shapes to one canvas', () => {
  const canvasId = generateTypeId('canvas')

  expect(shapeListParams(canvasId)).toEqual({
    canvasId,
    sort: 'createdAt',
    order: 'asc',
    limit: 200,
  })
})

test('createClientTypeId creates a browser-safe TypeID-shaped id', () => {
  expect(createClientTypeId('canvas')).toMatch(
    /^canvas_[0-9a-hjkmnp-tv-z]{26}$/,
  )
})
