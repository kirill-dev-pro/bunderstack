/**
 * Zero-runtime typed client generation from the app's OpenAPI document.
 *
 * `generateClientCode` turns `/api/openapi.json` into a standalone TypeScript
 * file: one function per operation, interfaces for component schemas, and —
 * only when the spec has event-stream operations — an inlined SSE parser so
 * live views are consumed as plain async iterables. The output imports
 * nothing: no client library, no runtime dependency, just `fetch`.
 *
 * This is the codegen counterpart of "never seal": the generated file is
 * ordinary code the user owns and can edit or delete.
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

export type GenerateClientCodeOptions = {
  /** Prefixed onto every request URL. Defaults to same-origin. */
  baseUrl?: string
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

/** JSON-schema subset → TypeScript type expression. */
export function schemaToType(schema: JsonSchema | undefined): string {
  if (!schema) return 'unknown'
  if (schema.$ref) {
    return pascal(schema.$ref.split('/').pop() ?? 'unknown')
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
      ...new Set(variants.map((member) => schemaToType(member))),
    ]
    const withoutNull = members.filter((member) => member !== 'null')
    const joined = withoutNull.join(' | ')
    const core =
      withoutNull.length > 1 ? `(${joined})` : joined || 'unknown'
    return members.length !== withoutNull.length ? `${core} | null` : core
  }
  if (schema.allOf) {
    return schema.allOf.map((member) => schemaToType(member)).join(' & ')
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
      return `${schemaToType(schema.items)}[]`
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
        return `${JSON.stringify(key)}${optional}: ${schemaToType(child)}`
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
  if (statics.length === 1 && method === 'post')
    return `${camel(last)}Create`
  // A deeper static path reads as its own name (`/api/posts/live`) — the
  // method suffix would only add noise.
  if (method === 'get') return camel(statics.join('_'))
  return `${camel(statics.join('_'))}${action}`
}

type EmittedOperation = {
  name: string
  method: string
  path: string
  hasIdArg: boolean
  bodyType?: string
  inputType?: string
  returnType: string
  isStream: boolean
}

const HTTP_METHODS = ['get', 'post', 'patch', 'put', 'delete']

function collectOperations(spec: OpenApiSpec): EmittedOperation[] {
  const operations: EmittedOperation[] = []
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const rawMethod of Object.keys(methods)) {
      if (!HTTP_METHODS.includes(rawMethod)) continue
      const operation = methods[rawMethod]
      if (!operation) continue

      const parameters = operation.parameters ?? []
      const hasIdArg = parameters.some(
        (parameter) => parameter.in === 'path',
      )
      const queryParameters = parameters.filter(
        (parameter) => parameter.in === 'query',
      )

      let inputType: string | undefined
      if (queryParameters.length > 0) {
        const fields = queryParameters.map((parameter) => {
          const schema =
            parameter.schema ??
            parameter.content?.['application/json']?.schema
          // Query values are strings on the wire unless serialized as JSON.
          const type = schema?.type === 'object' ? schemaToType(schema) : schemaToType(schema)
          return `${JSON.stringify(parameter.name)}?: ${type}`
        })
        inputType = `{ ${fields.join('; ')} }`
      }

      const requestSchema =
        operation.requestBody?.content?.['application/json']?.schema
      // oRPC emits an empty-object request body even for body-less
      // procedures like DELETE; a free-form record there is noise.
      const rawBodyType = requestSchema ? schemaToType(requestSchema) : undefined
      const bodyType =
        rawBodyType === 'Record<string, unknown>' &&
        ['delete'].includes(rawMethod)
          ? undefined
          : rawBodyType

      const okResponse =
        operation.responses?.['200'] ?? operation.responses?.['201']
      const jsonSchema = okResponse?.content?.['application/json']?.schema
      const eventSchema = okResponse?.content?.['text/event-stream']?.schema

      let returnType = 'Promise<void>'
      let isStream = false
      if (eventSchema) {
        isStream = true
        // oRPC wraps each SSE data frame as {event, data}; unwrap the payload.
        // Wrapper variants that carry no data (or map to `unknown`) would
        // swallow the whole union, so they are dropped here.
        const wrapper = eventSchema.oneOf ?? eventSchema.anyOf ?? []
        const frameTypes = [
          ...new Set(
            wrapper
              .map((variant) => variant.properties?.['data'])
              .filter((variant): variant is JsonSchema => Boolean(variant))
              .map(schemaToType)
              .filter((type) => type !== 'unknown'),
          ),
        ]
        returnType = `AsyncIterable<${frameTypes.join(' | ')}>`
      } else if (jsonSchema) {
        returnType = `Promise<${schemaToType(jsonSchema)}>`
      }

      operations.push({
        name: operationName(path, rawMethod),
        method: rawMethod.toUpperCase(),
        path,
        hasIdArg,
        bodyType,
        inputType,
        returnType,
        isStream,
      })
    }
  }
  return operations
}

const REQUEST_HELPER = `
async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(response.status + ' ' + (await response.text()))
  if (response.status === 204) return undefined
  return response.json()
}

function withQuery(url: string, input?: Record<string, unknown>): string {
  if (!input) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    params.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return params.size ? url + '?' + params : url
}
`

const SSE_HELPER = `
// Inlined from bunderstack's live-view contract: frames are SSE events whose
// data is JSON; keepalive comments never surface here. Typed as any so the
// wrapper below can narrow to the operation's own frame union.
async function* sseFrames(url: string, signal: AbortSignal): AsyncGenerator<any> {
  const response = await fetch(url, { signal, headers: { accept: 'text/event-stream' } })
  if (!response.ok || !response.body) throw new Error('Live request failed (' + response.status + ')')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data: string[] = []
  const flush = (): unknown => {
    if (data.length === 0) return undefined
    const parsed = JSON.parse(data.join('\\n'))
    data = []
    return parsed
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      let newline: number
      while ((newline = buffer.indexOf('\\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          const frame = flush()
          if (frame !== undefined) yield frame
        } else if (line.startsWith('data: ')) {
          data.push(line.slice(6))
        }
      }
    }
    const frame = flush()
    if (frame !== undefined) yield frame
  } finally {
    await reader.cancel().catch(() => {})
  }
}
`

export function generateClientCode(
  input: unknown,
  options: GenerateClientCodeOptions = {},
): string {
  const spec = input as OpenApiSpec
  const baseUrl = options.baseUrl ?? ''
  const operations = collectOperations(spec)
  const hasStreams = operations.some((operation) => operation.isStream)

  const lines: string[] = []
  lines.push('// Generated by bunderstack codegen from /api/openapi.json.')
  lines.push('// Owned by you: edit, trim, or regenerate freely.')
  lines.push(`const BASE_URL = ${JSON.stringify(baseUrl)}`)
  lines.push('')

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    lines.push(`export type ${pascal(name)} = ${schemaToType(schema)}`)
  }
  if (Object.keys(spec.components?.schemas ?? {}).length > 0) lines.push('')

  lines.push(REQUEST_HELPER)
  if (hasStreams) lines.push(SSE_HELPER)

  for (const operation of operations) {
    const args: string[] = []
    if (operation.hasIdArg) args.push('id: string')
    if (operation.inputType) args.push(`input?: ${operation.inputType}`)
    if (operation.bodyType) args.push(`body: ${operation.bodyType}`)
    if (operation.isStream) args.push('signal?: AbortSignal')

    lines.push(
      operation.isStream
        ? `export async function* ${operation.name}(`
        : `export async function ${operation.name}(`,
    )
    for (const arg of args) lines.push(`  ${arg},`)
    lines.push(`): ${operation.returnType} {`)
    lines.push(
      `  const url = withQuery(BASE_URL + ${JSON.stringify(operation.path)}${
        operation.hasIdArg
          ? `.replace('{id}', encodeURIComponent(String(id)))`
          : ''
      }${operation.inputType ? ', input)' : ', undefined)'}`,
    )

    if (operation.isStream) {
      lines.push(
        `  yield* sseFrames(url, signal ?? new AbortController().signal)`,
      )
    } else {
      const init = [
        `method: ${JSON.stringify(operation.method)}`,
        operation.bodyType
          ? `headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)`
          : undefined,
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(`  return requestJson(url, { ${init} }) as never`)
    }
    lines.push('}')
    lines.push('')
  }

  return lines.join('\n')
}
