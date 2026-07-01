import { expect, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'

import {
  canvasListParams,
  createClientTypeId,
  createShapeDraft,
  shapeListParams,
} from './canvas-data'

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

test('createShapeDraft builds default geometry for visual tools', () => {
  expect(createShapeDraft('ellipse', { x: 40, y: 60 }, '#2563eb')).toEqual({
    type: 'ellipse',
    x: -40,
    y: 12,
    width: 160,
    height: 96,
    rotation: 0,
    color: '#2563eb',
    text: null,
    imageFileId: null,
    imageName: null,
  })

  expect(createShapeDraft('diamond', { x: 40, y: 60 }, '#2563eb')).toEqual({
    type: 'diamond',
    x: -30,
    y: -10,
    width: 140,
    height: 140,
    rotation: 0,
    color: '#2563eb',
    text: null,
    imageFileId: null,
    imageName: null,
  })
})

test('createShapeDraft includes text and Bunderstack image references', () => {
  expect(
    createShapeDraft('text', { x: 100, y: 120 }, '#0f172a', {
      text: 'Ship it',
    }),
  ).toMatchObject({
    type: 'text',
    text: 'Ship it',
    imageFileId: null,
  })

  expect(
    createShapeDraft('image', { x: 100, y: 120 }, '#0f172a', {
      imageFileId: 'images/mock.png',
      imageName: 'mock.png',
    }),
  ).toMatchObject({
    type: 'image',
    text: null,
    imageFileId: 'images/mock.png',
    imageName: 'mock.png',
  })
})
