import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { EnvConfigInput } from './env'

import { validateStandardSchema } from './standard-schema'

const CANDIDATES: readonly (string | undefined)[] = [
  undefined,
  '',
  'probe',
  'true',
  'false',
  '0',
  '1',
  'https://example.invalid',
  'file:./bunderstack-probe.db',
  'probe@example.invalid',
  '00000000-0000-4000-8000-000000000000',
]

const BASE_SOURCE = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'bunderstack-blueprint-probe-secret',
  DATABASE_URL: 'file:./bunderstack-blueprint-probe.db',
  BUNDERSTACK_ROLE: 'all',
} satisfies Record<string, string | undefined>

export class BlueprintProbeError extends Error {
  constructor(key: string) {
    super(
      `[bunderstack] cannot synthesize a valid blueprint probe for env key ${key}; ` +
        'provide a valid value while generating the blueprint',
    )
    this.name = 'BlueprintProbeError'
  }
}

function identity(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && Number.isNaN(value)) return 'number:NaN'
  try {
    return `${typeof value}:${JSON.stringify(value)}`
  } catch {
    return `${typeof value}:${String(value)}`
  }
}

function acceptedValues(
  key: string,
  schema: StandardSchemaV1,
  configured: string | undefined,
): (string | undefined)[] {
  const accepted: (string | undefined)[] = []
  const outputs = new Set<string>()
  for (const candidate of [configured, ...CANDIDATES]) {
    try {
      const output = validateStandardSchema(schema, candidate, 'env')
      const id = identity(output)
      if (outputs.has(id)) continue
      outputs.add(id)
      accepted.push(candidate)
      if (accepted.length === 2) return accepted
    } catch {
      // Candidate failures are expected. The eventual error names only the key.
    }
  }
  if (accepted.length === 0) throw new BlueprintProbeError(key)
  return accepted
}

export function createEnvProbeSources(
  envSchema: EnvConfigInput | undefined,
  configured: Record<string, string | undefined>,
): readonly [
  Record<string, string | undefined>,
  Record<string, string | undefined>,
] {
  const first: Record<string, string | undefined> = { ...BASE_SOURCE }
  const second: Record<string, string | undefined> = { ...BASE_SOURCE }
  const variables = { ...envSchema?.server, ...envSchema?.client }
  for (const [key, schema] of Object.entries(variables)) {
    const values = acceptedValues(key, schema, configured[key])
    first[key] = values[0]
    second[key] = values[1] ?? values[0]
  }
  return [first, second]
}
