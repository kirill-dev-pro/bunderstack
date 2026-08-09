import { getOpenAPIMeta } from '@orpc/openapi'

export interface ApiRegistryEntry {
  handle: string
  operationId: string
  method: string
  path: string
  source: 'native' | 'foreign'
}

export interface ApiRegistry {
  entries: ApiRegistryEntry[]
}

export interface BuildApiRegistryOptions {
  nativeRouter?: Record<string, unknown>
  foreignSpecs?: Array<Record<string, unknown>>
}

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])

function normalizePathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function isParamSegment(segment: string): boolean {
  return (
    (segment.startsWith('{') && segment.endsWith('}')) ||
    segment.startsWith(':')
  )
}

function normalizePathForCollision(path: string): string {
  const segments = normalizePathSegments(path)
  const normalized = segments.map((seg) =>
    isParamSegment(seg) ? '{param}' : seg,
  )
  return '/' + normalized.join('/')
}

function walkNativeRouter(
  obj: Record<string, unknown>,
  pathSegments: string[] = [],
): ApiRegistryEntry[] {
  const entries: ApiRegistryEntry[] = []

  for (const [key, value] of Object.entries(obj)) {
    if (!value || typeof value !== 'object') continue
    const currentSegments = [...pathSegments, key]

    // oRPC procedure check
    if ('~orpc' in value) {
      const meta = getOpenAPIMeta(value as any) || {}
      const handle = currentSegments.join('.')
      const method = (meta.method || 'GET').toUpperCase()
      const routePath = meta.path || '/' + currentSegments.join('/')

      entries.push({
        handle,
        operationId: handle,
        method,
        path: routePath,
        source: 'native',
      })
    } else {
      entries.push(
        ...walkNativeRouter(
          value as Record<string, unknown>,
          currentSegments,
        ),
      )
    }
  }

  return entries
}

function extractForeignEntries(
  specs: Array<Record<string, unknown>>,
): ApiRegistryEntry[] {
  const entries: ApiRegistryEntry[] = []

  for (const spec of specs) {
    if (!spec || typeof spec.paths !== 'object' || !spec.paths) continue
    const paths = spec.paths as Record<string, Record<string, unknown>>

    for (const [routePath, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue

      for (const [methodKey, operation] of Object.entries(pathItem)) {
        const uppercaseMethod = methodKey.toUpperCase()
        if (!HTTP_METHODS.has(uppercaseMethod)) continue
        if (!operation || typeof operation !== 'object') continue

        const op = operation as Record<string, unknown>
        const operationId =
          typeof op.operationId === 'string'
            ? op.operationId
            : `${uppercaseMethod.toLowerCase()}:${routePath}`
        const handle = operationId

        entries.push({
          handle,
          operationId,
          method: uppercaseMethod,
          path: routePath,
          source: 'foreign',
        })
      }
    }
  }

  return entries
}

export async function buildApiRegistry(
  options: BuildApiRegistryOptions = {},
): Promise<ApiRegistry> {
  const entries: ApiRegistryEntry[] = []

  if (options.nativeRouter) {
    entries.push(...walkNativeRouter(options.nativeRouter))
  }

  if (options.foreignSpecs) {
    entries.push(...extractForeignEntries(options.foreignSpecs))
  }

  const errors: string[] = []

  // Check duplicate handles
  const handleMap = new Map<string, ApiRegistryEntry>()
  for (const entry of entries) {
    const existing = handleMap.get(entry.handle)
    if (existing) {
      errors.push(
        `Duplicate handle "${entry.handle}": collision between ${existing.source} (${existing.method} ${existing.path}) and ${entry.source} (${entry.method} ${entry.path})`,
      )
    } else {
      handleMap.set(entry.handle, entry)
    }
  }

  // Check duplicate operation IDs
  const opIdMap = new Map<string, ApiRegistryEntry>()
  for (const entry of entries) {
    const existing = opIdMap.get(entry.operationId)
    if (existing) {
      errors.push(
        `Duplicate operation ID "${entry.operationId}": collision between ${existing.source} (${existing.method} ${existing.path}) and ${entry.source} (${entry.method} ${entry.path})`,
      )
    } else {
      opIdMap.set(entry.operationId, entry)
    }
  }

  // Check method/path collisions (exact and parameter ambiguity)
  const routePatternMap = new Map<string, ApiRegistryEntry>()
  for (const entry of entries) {
    const normalizedPath = normalizePathForCollision(entry.path)
    const routeKey = `${entry.method} ${normalizedPath}`

    const existing = routePatternMap.get(routeKey)
    if (existing) {
      if (existing.path === entry.path) {
        errors.push(
          `Exact method/path collision on ${entry.method} ${entry.path}: collision between ${existing.source} (${existing.handle}) and ${entry.source} (${entry.handle})`,
        )
      } else {
        errors.push(
          `Ambiguous parameter path collision on ${entry.method} (${existing.path} vs ${entry.path}): collision between ${existing.source} (${existing.handle}) and ${entry.source} (${entry.handle})`,
        )
      }
    } else {
      routePatternMap.set(routeKey, entry)
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[bunderstack] Route registry validation failed (${errors.length} error(s)):\n` +
        errors.join('\n'),
    )
  }

  return { entries }
}
