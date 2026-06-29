import { describe, it, expect } from 'bun:test'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { buildScopeWhere } from './scope'

const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
})

describe('buildScopeWhere', () => {
  it('returns a condition for single value', () => {
    expect(buildScopeWhere(boards, { organizationId: 'org_1' })).toBeDefined()
  })
  it('returns a condition for array value', () => {
    expect(
      buildScopeWhere(boards, { organizationId: ['org_1', 'org_2'] }),
    ).toBeDefined()
  })
  it('returns undefined for empty scope', () => {
    expect(buildScopeWhere(boards, {})).toBeUndefined()
  })
  it('skips unknown columns', () => {
    expect(buildScopeWhere(boards, { nope: 'x' })).toBeUndefined()
  })
})
