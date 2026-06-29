import { describe, it, expect } from 'bun:test'

import type { AccessContext } from './access.ts'

import { resolveConfig } from './config.ts'

describe('resolveConfig with function access rules', () => {
  it('does not throw when access uses functions and scope', () => {
    expect(() =>
      resolveConfig({
        schema: {},
        access: {
          boards: {
            list: () => true,
            scope: (ctx: AccessContext) => ({
              organizationId: ctx.session?.activeOrganizationId ?? '',
            }),
          },
        },
        realtime: true,
      } as never),
    ).not.toThrow()
  })
})
