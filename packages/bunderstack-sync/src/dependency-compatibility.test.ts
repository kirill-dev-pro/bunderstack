import { describe, expect, it } from 'bun:test'

import manifest from '../package.json' with { type: 'json' }

describe('TanStack dependency compatibility', () => {
  it('requires the exact TanStack DB versions used to construct collections', () => {
    expect(manifest.devDependencies['@tanstack/db']).toBe('0.6.16')
    expect(manifest.devDependencies['@tanstack/query-db-collection']).toBe(
      '1.1.0',
    )
    expect(manifest.peerDependencies['@tanstack/db']).toBe('0.6.16')
    expect(manifest.peerDependencies['@tanstack/query-db-collection']).toBe(
      '1.1.0',
    )
  })
})
