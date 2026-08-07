// src/routes.ts — mounting user-supplied Hono routes inside the app.

/** A route as Hono reports it on `app.routes`. */
export type DeclaredRoute = { method: string; path: string }

const RESERVED_EXACT = ['/health', '/api/health', '/api/realtime'] as const

const RESERVED_PREFIXES = [
  '/api/auth/',
  '/api/trpc/',
  '/api/files/',
  '/files/',
] as const

/** The first path segment under `/api/`, or undefined when not under it. */
function apiSegment(path: string): string | undefined {
  if (!path.startsWith('/api/')) return undefined
  return path.slice('/api/'.length).split('/')[0]
}

function collisionFor(
  route: DeclaredRoute,
  tableNames: readonly string[],
): string | undefined {
  const { path } = route
  if (RESERVED_EXACT.includes(path as (typeof RESERVED_EXACT)[number])) {
    return `it is reserved by bunderstack`
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (path.startsWith(prefix)) {
      return `"${prefix}*" is reserved by bunderstack`
    }
  }
  const segment = apiSegment(path)
  if (segment === undefined) return undefined
  if (segment === '*' || segment.startsWith(':')) {
    return `a parameter or wildcard here would shadow every generated CRUD route`
  }
  if (tableNames.includes(segment)) {
    return `it collides with the generated CRUD route for table "${segment}"`
  }
  return undefined
}

/**
 * Throws when any declared route would collide with a bunderstack route.
 *
 * Custom routes are registered before the built-ins, so a collision silently
 * shadows core behaviour — including authentication. Failing at construction is
 * the cheapest place to find out.
 */
export function validateCustomRoutes(
  routes: readonly DeclaredRoute[],
  tableNames: readonly string[],
): void {
  const problems: string[] = []
  for (const route of routes) {
    const reason = collisionFor(route, tableNames)
    if (reason) {
      problems.push(`  ${route.method} ${route.path} — ${reason}`)
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `[bunderstack] routes: ${problems.length} route(s) collide with bunderstack's own:\n${problems.join('\n')}\nChoose different paths.`,
  )
}
