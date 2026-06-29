import { describe, it, expect } from 'bun:test'

import { rowMatchesScope, stampScope } from './access.ts'

describe('rowMatchesScope', () => {
  it('matches single-value scope', () => {
    expect(
      rowMatchesScope({ organizationId: 'org_1' }, { organizationId: 'org_1' }),
    ).toBe(true)
    expect(
      rowMatchesScope({ organizationId: 'org_2' }, { organizationId: 'org_1' }),
    ).toBe(false)
  })
  it('matches array (membership) scope', () => {
    expect(
      rowMatchesScope(
        { organizationId: 'org_2' },
        { organizationId: ['org_1', 'org_2'] },
      ),
    ).toBe(true)
    expect(
      rowMatchesScope(
        { organizationId: 'org_9' },
        { organizationId: ['org_1', 'org_2'] },
      ),
    ).toBe(false)
  })
  it('fails when the scoped column is missing/null', () => {
    expect(rowMatchesScope({}, { organizationId: 'org_1' })).toBe(false)
  })
  it('requires all keys to match', () => {
    expect(
      rowMatchesScope(
        { organizationId: 'org_1', userId: 'u_2' },
        { organizationId: 'org_1', userId: 'u_1' },
      ),
    ).toBe(false)
  })
})

describe('stampScope', () => {
  it('overwrites single-value scope columns, ignores arrays', () => {
    expect(
      stampScope(
        { title: 'x', organizationId: 'spoofed' },
        { organizationId: 'org_1' },
      ),
    ).toEqual({ title: 'x', organizationId: 'org_1' })
    expect(
      stampScope({ title: 'x' }, { organizationId: ['org_1', 'org_2'] }),
    ).toEqual({ title: 'x' })
  })
})

import { resolveSession } from './access.ts'

describe('resolveSession', () => {
  it('returns null user and org when no auth', async () => {
    expect(await resolveSession(undefined, new Headers())).toEqual({
      user: null,
      activeOrganizationId: null,
    })
  })
  it('extracts activeOrganizationId from the session', async () => {
    const auth = {
      api: {
        getSession: async () => ({
          user: { id: 'u_1', email: 'a@b.c', name: 'A' },
          session: { activeOrganizationId: 'org_1' },
        }),
      },
    }
    expect(await resolveSession(auth as never, new Headers())).toEqual({
      user: { id: 'u_1', email: 'a@b.c', name: 'A' },
      activeOrganizationId: 'org_1',
    })
  })
})
