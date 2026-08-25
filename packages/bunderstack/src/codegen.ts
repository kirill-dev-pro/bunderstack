/**
 * Typed route-map generation from the app's OpenAPI document.
 *
 * `generateRouteMap` turns `/api/openapi.json` into a small standalone module:
 * an `ApiRoutes` type — one `Op` entry per operation, carrying its method,
 * path literal, query/body/output types and whether it streams — plus a
 * runtime `routes` descriptor object for that same list.
 *
 * The transport itself is deliberately NOT generated: a ~90-line handwritten
 * client (`createRestClient`) consumes any route map. Types change with every API
 * edit and are regenerated; the client never changes at all.
 */

type JsonSchema = {
  $ref?: string
  type?: string | string[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  const?: unknown
  enum?: unknown[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
}

type Parameter = {
  in: string
  name: string
  schema?: JsonSchema
  content?: Record<string, { schema: JsonSchema }>
}

type Operation = {
  parameters?: Parameter[]
  requestBody?: { content?: Record<string, { schema: JsonSchema }> }
  responses?: Record<
    string,
    { content?: Record<string, { schema: JsonSchema }> }
  >
}

type OpenApiSpec = {
  paths?: Record<string, Record<string, Operation | undefined>>
  components?: { schemas?: Record<string, JsonSchema> }
}

function pascal(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('')
}

function camel(value: string): string {
  const asPascal = pascal(value)
  return asPascal ? asPascal[0]!.toLowerCase() + asPascal.slice(1) : 'root'
}

/** JSON-schema subset → TypeScript type expression, with $refs inlined. */
export function schemaToType(
  schema: JsonSchema | undefined,
  components: Record<string, JsonSchema> = {},
  depth = 0,
): string {
  if (!schema || depth > 4) return 'unknown'
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop() ?? ''
    return schemaToType(components[name], components, depth + 1)
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum) {
    return [...new Set(schema.enum.map((value) => JSON.stringify(value)))].join(
      ' | ',
    )
  }
  const variants = schema.anyOf ?? schema.oneOf
  if (variants) {
    const members = [
      ...new Set(
        variants.map((member) => schemaToType(member, components, depth)),
      ),
    ]
    const withoutNull = members.filter((member) => member !== 'null')
    const joined = withoutNull.join(' | ')
    const core = withoutNull.length > 1 ? `(${joined})` : joined || 'unknown'
    return members.length !== withoutNull.length ? `${core} | null` : core
  }
  if (schema.allOf) {
    return schema.allOf
      .map((member) => schemaToType(member, components, depth))
      .join(' & ')
  }
  if (Array.isArray(schema.type)) {
    return schema.type
      .map((entry) => (entry === 'integer' ? 'number' : entry))
      .join(' | ')
  }
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array':
      return `${schemaToType(schema.items, components, depth)}[]`
    case 'object': {
      const properties = schema.properties ?? {}
      const required = new Set(schema.required ?? [])
      if (Object.keys(properties).length === 0) {
        return schema.additionalProperties === false
          ? 'Record<string, never>'
          : 'Record<string, unknown>'
      }
      const fields = Object.entries(properties).map(([key, child]) => {
        const optional = required.has(key) ? '' : '?'
        return `${JSON.stringify(key)}${optional}: ${schemaToType(child, components, depth)}`
      })
      return `{ ${fields.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

const METHOD_ACTIONS: Record<string, string> = {
  get: 'Get',
  post: 'Create',
  patch: 'Update',
  put: 'Update',
  delete: 'Delete',
}

/**
 * Deterministic operation names from the path shape:
 * `/api/posts` GET → `postsList`; `/api/posts/{id}` PATCH → `postsUpdate`;
 * `/api/posts/live` GET → `postsLive`; `/api/enrich` POST → `enrichCreate`.
 */
export function operationName(path: string, method: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === 'api') segments.shift()
  const last = segments[segments.length - 1] ?? ''
  const action = METHOD_ACTIONS[method] ?? pascal(method)

  if (last.startsWith('{')) {
    return `${camel(segments.slice(0, -1).join('_'))}${action}`
  }
  const statics = segments.filter((segment) => !segment.startsWith('{'))
  if (statics.length === 1 && method === 'get') return `${camel(last)}List`
  if (statics.length === 1 && method === 'post') return `${camel(last)}Create`
  // A deeper static path reads as its own name (`/api/posts/live`) — the
  // method suffix would only add noise.
  if (method === 'get') return camel(statics.join('_'))
  return `${camel(statics.join('_'))}${action}`
}

type EmittedOperation = {
  name: string
  method: string
  path: string
  queryType?: string
  bodyType?: string
  outputType: string
  isStream: boolean
}

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete']

function collectOperations(spec: OpenApiSpec): EmittedOperation[] {
  const components = spec.components?.schemas ?? {}
  const operations: EmittedOperation[] = []

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    // Better Auth owns its client contract. Keeping auth endpoints out of the
    // generic REST artifact avoids a second, less capable auth API surface.
    if (path === '/api/auth' || path.startsWith('/api/auth/')) continue
    for (const rawMethod of Object.keys(methods)) {
      if (!HTTP_METHODS.includes(rawMethod)) continue
      const operation = methods[rawMethod]
      if (!operation) continue

      const parameters = operation.parameters ?? []
      const queryParameters = parameters.filter(
        (parameter) => parameter.in === 'query',
      )

      let queryType: string | undefined
      if (queryParameters.length > 0) {
        const fields = queryParameters.map((parameter) => {
          const schema =
            parameter.schema ?? parameter.content?.['application/json']?.schema
          return `${JSON.stringify(parameter.name)}?: ${schemaToType(schema, components)}`
        })
        queryType = `{ ${fields.join('; ')} }`
      }

      const requestSchema =
        operation.requestBody?.content?.['application/json']?.schema
      const rawBodyType = requestSchema
        ? schemaToType(requestSchema, components)
        : undefined
      // oRPC emits an empty-object request body even for body-less
      // procedures like DELETE; a free-form record there is noise.
      const bodyType =
        rawBodyType === 'Record<string, unknown>' && rawMethod === 'delete'
          ? undefined
          : rawBodyType

      const okResponse =
        operation.responses?.['200'] ?? operation.responses?.['201']
      const jsonSchema = okResponse?.content?.['application/json']?.schema
      const eventSchema = okResponse?.content?.['text/event-stream']?.schema

      let outputType = 'void'
      let isStream = false
      if (eventSchema) {
        isStream = true
        // oRPC wraps each SSE data frame as {event, data}; unwrap the payload.
        // Wrapper variants that carry no data (or map to `unknown`) would
        // swallow the whole union, so they are dropped here.
        const wrapper = eventSchema.oneOf ?? eventSchema.anyOf ?? []
        outputType =
          [
            ...new Set(
              wrapper
                .map((variant) => variant.properties?.['data'])
                .filter((variant): variant is JsonSchema => Boolean(variant))
                .map((variant) => schemaToType(variant, components))
                .filter((type) => type !== 'unknown'),
            ),
          ].join(' | ') || 'void'
      } else if (jsonSchema) {
        outputType = schemaToType(jsonSchema, components)
      }

      operations.push({
        name: operationName(path, rawMethod),
        method: rawMethod.toUpperCase(),
        path,
        queryType,
        bodyType,
        outputType,
        isStream,
      })
    }
  }
  return operations
}

export function generateRouteMap(input: unknown): string {
  const spec = input as OpenApiSpec
  const operations = collectOperations(spec)

  const lines: string[] = []
  lines.push('// Generated by bunderstack codegen from /api/openapi.json.')
  lines.push('// Regenerate with `bun run gen`; do not edit by hand.')
  lines.push('')
  lines.push(
    '/** One API operation: literals describe the wire, phantoms the shapes. */',
  )
  lines.push('export interface Op<')
  lines.push('  M extends string,')
  lines.push('  P extends string,')
  lines.push('  Query = undefined,')
  lines.push('  Body = undefined,')
  lines.push('  Output = void,')
  lines.push('  Stream extends boolean = false,')
  lines.push('> {')
  lines.push('  method: M')
  lines.push('  path: P')
  lines.push('  stream: Stream')
  lines.push('  query?: Query')
  lines.push('  body?: Body')
  lines.push('  output?: Output')
  lines.push('}')
  lines.push('')
  lines.push('export type ApiRoutes = {')

  const runtimeEntries: string[] = []
  for (const operation of operations) {
    const generics = [
      `'${operation.method}'`,
      `'${operation.path}'`,
      operation.queryType ?? 'undefined',
      operation.bodyType ?? 'undefined',
      operation.isStream ? operation.outputType : operation.outputType,
      String(operation.isStream),
    ].join(', ')
    lines.push(`  ${operation.name}: Op<${generics}>`)
    runtimeEntries.push(
      `  ${operation.name}: { method: '${operation.method}', path: '${operation.path}'${
        operation.isStream ? ', stream: true' : ''
      } },`,
    )
  }
  lines.push('}')
  lines.push('')
  lines.push(
    '/** Wire descriptors for createRestClient — same keys, runtime values. */',
  )
  lines.push('export const routes = {')
  lines.push(...runtimeEntries)
  lines.push('} as const')

  return lines.join('\n')
}
