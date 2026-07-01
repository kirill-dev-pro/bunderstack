import { expect, test } from 'bun:test'
import { generateTypeId } from 'bunderstack'

import { normalizeSessionUser } from './session'

test('normalizeSessionUser returns a route-safe auth user', () => {
  const id = generateTypeId('user')

  expect(
    normalizeSessionUser({
      user: {
        id,
        email: 'artist@example.com',
        name: 'Artist',
        image: null,
      },
    }),
  ).toEqual({
    id,
    email: 'artist@example.com',
    name: 'Artist',
    image: null,
  })
})

test('normalizeSessionUser treats malformed session ids as logged out', () => {
  expect(
    normalizeSessionUser({
      user: {
        id: 'legacy-user-id',
        email: 'artist@example.com',
        name: 'Artist',
        image: null,
      },
    }),
  ).toBeNull()
})
