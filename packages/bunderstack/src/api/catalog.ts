// src/api/catalog.ts — static description of the application's own procedures.
import { getOpenAPIMeta } from '@orpc/openapi'

import type { ApiOperation } from '../manifest'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const MAX_SUMMARY = 200

function summaryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const collapsed = value.trim().replace(/\s+/g, ' ')
  if (!collapsed) return undefined
  return collapsed.length > MAX_SUMMARY
    ? `${collapsed.slice(0, MAX_SUMMARY - 1)}…`
    : collapsed
}

function walk(
  router: Record<string, unknown>,
  segments: string[],
): ApiOperation[] {
  const operations: ApiOperation[] = []

  for (const [key, value] of Object.entries(router)) {
    if (!value || typeof value !== 'object') continue
    const current = [...segments, key]

    if (!('~orpc' in value)) {
      operations.push(...walk(value as Record<string, unknown>, current))
      continue
    }

    const meta = (getOpenAPIMeta(value as never) ?? {}) as Record<
      string,
      unknown
    >
    const handle = current.join('.')
    const method =
      typeof meta.method === 'string' ? meta.method.toUpperCase() : undefined
    const summary = summaryText(meta.summary)

    operations.push({
      handle,
      operationId:
        typeof meta.operationId === 'string' ? meta.operationId : handle,
      // A procedure that declares no method could be anything. Calling it a
      // read would tell a host it is safe to invoke without asking anyone.
      effect:
        method === undefined
          ? 'unknown'
          : READ_METHODS.has(method)
            ? 'read'
            : 'mutation',
      ...(method === undefined ? {} : { method }),
      ...(typeof meta.path === 'string' ? { path: meta.path } : {}),
      ...(summary === undefined ? {} : { summary }),
    })
  }

  return operations
}

/**
 * Describes the procedures an application declared itself. Generated CRUD,
 * storage, and realtime routes are excluded: a host derives those from the
 * blueprint's `resources`.
 */
export function describeApiOperations(router: unknown): ApiOperation[] {
  if (!router || typeof router !== 'object') return []
  return walk(router as Record<string, unknown>, []).sort((left, right) =>
    left.handle.localeCompare(right.handle),
  )
}
