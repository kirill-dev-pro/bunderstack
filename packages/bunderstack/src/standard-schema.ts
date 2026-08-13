import type { StandardSchemaV1 } from '@standard-schema/spec'

export type StandardSchema = StandardSchemaV1
export type InferStandardOutput<TSchema extends StandardSchemaV1> =
  StandardSchemaV1.InferOutput<TSchema>

export type StandardSchemaIssue = {
  path: PropertyKey[]
  message: string
}

export class StandardSchemaValidationError extends Error {
  readonly issues: StandardSchemaIssue[]

  constructor(label: string, issues: readonly StandardSchemaV1.Issue[]) {
    const normalized = issues.map((issue) => ({
      path: [...(issue.path ?? [])].map((segment) =>
        typeof segment === 'object' ? segment.key : segment,
      ),
      message: issue.message,
    }))
    super(
      normalized
        .map((issue) => {
          const path = issue.path.map(String).join('.')
          return `${label}${path ? `.${path}` : ''}: ${issue.message}`
        })
        .join('\n'),
    )
    this.name = 'StandardSchemaValidationError'
    this.issues = normalized
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

export function validateStandardSchema<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  value: unknown,
  label: string,
): StandardSchemaV1.InferOutput<TSchema> {
  const result = schema['~standard'].validate(value)
  if (isPromiseLike(result)) {
    throw new Error(
      `[bunderstack] ${label} schema validation must be synchronous`,
    )
  }
  if (result.issues) {
    throw new StandardSchemaValidationError(label, result.issues)
  }
  return result.value
}
