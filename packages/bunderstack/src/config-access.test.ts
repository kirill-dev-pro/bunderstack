import { describe, it, expect } from 'bun:test'

import type { AccessContext } from './access'

import { resolveConfig } from './config'

describe('resolveConfig with function access rules', () => {
  it('does not throw when access uses functions and scope', () => {
    expect(() =>
      resolveConfig({
        schema: {},
        access: {
          boards: {
            list: () => true,
            scope: {
              read: (ctx: AccessContext) => ({
                organizationId: ctx.session?.activeOrganizationId ?? '',
              }),
              write: (ctx: AccessContext) => ({
                organizationId: ctx.session?.activeOrganizationId ?? '',
              }),
            },
          },
        },
        realtime: true,
      } as never),
    ).not.toThrow()
  })
})
