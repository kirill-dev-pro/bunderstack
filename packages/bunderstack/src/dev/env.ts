// The Worker env for `bunderstack dev`: the app's .env files plus the values
// the dev command owns, written as .dev.vars for celld.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    )
    if (!match) continue
    const [, key, rest] = match as unknown as [string, string, string]
    let value: string
    if (rest.startsWith('"')) {
      const end = rest.lastIndexOf('"')
      value = rest
        .slice(1, end > 0 ? end : undefined)
        .replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c))
    } else if (rest.startsWith("'")) {
      const end = rest.lastIndexOf("'")
      value = rest.slice(1, end > 0 ? end : undefined)
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }
    vars[key] = value
  }
  return vars
}

export async function readUserEnv(
  directory: string,
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {}
  for (const name of ['.env', '.env.local']) {
    const text = await readFile(join(directory, name), 'utf8').catch(
      () => undefined,
    )
    if (text !== undefined) Object.assign(vars, parseDotenv(text))
  }
  return vars
}

/** A random AUTH_SECRET kept in the dev state dir, so sessions survive restarts. */
export async function devSecret(stateDir: string): Promise<string> {
  const path = join(stateDir, 'auth-secret')
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim()
  if (existing) return existing
  await mkdir(stateDir, { recursive: true })
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  )
  await writeFile(path, `${secret}\n`, { mode: 0o600 })
  return secret
}

function quote(value: string) {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value
  return `"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\n')}"`
}

export function devVars(input: {
  userEnv: Record<string, string>
  databaseUrl: string
  appUrl: string
  authSecret: string
}): string {
  const vars: Record<string, string> = {
    ...input.userEnv,
    AUTH_SECRET: input.userEnv.AUTH_SECRET || input.authSecret,
    // The dev command picks these; a value from .env would point elsewhere.
    APP_URL: input.appUrl,
    BUNDERSTACK_DATABASE_URL: input.databaseUrl,
  }
  return (
    Object.entries(vars)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join('\n') + '\n'
  )
}
