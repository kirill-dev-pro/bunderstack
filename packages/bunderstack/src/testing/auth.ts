export type TestUser = {
  id: string
  email: string
  name: string
  emailVerified?: boolean
  image?: string | null
  createdAt?: string | Date
  updatedAt?: string | Date
}

export type TestIdentity = {
  user: TestUser
  headers: Headers
}

export class TestAuthError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Better Auth request failed (${status})`)
    this.name = 'TestAuthError'
    this.status = status
    this.body = body
  }
}

export type SignUpEmailInput = {
  email: string
  name: string
  password?: string
}

export type SignInEmailInput = {
  email: string
  password?: string
}

export type TestSession = {
  user: TestUser
  session: { activeOrganizationId?: string | null } | null
}

export type TestAuth = {
  signUpEmail(input: SignUpEmailInput): Promise<TestIdentity>
  signInEmail(input: SignInEmailInput): Promise<TestIdentity>
  getSession(identity: TestIdentity): Promise<TestSession | null>
  signOut(identity: TestIdentity): Promise<void>
  verifyEmail(identity: TestIdentity): Promise<TestIdentity>
  mockSession<TUser extends TestUser>(
    user: TUser,
    session?: { activeOrganizationId?: string | null } | null,
  ): TestIdentity & { user: TUser }
}

export type AuthSessionResolverLike = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<unknown>
  }
}

export type BunderstackAppLike = {
  auth: unknown
}

const TEST_SESSION_HEADER = 'x-bunderstack-test-session'

export type TestSessionRegistry = {
  readonly resolver: AuthSessionResolver
  attach(app: BunderstackAppLike): void
  mocked(headers: Headers): TestSession | undefined
  mock<TUser extends TestUser>(
    user: TUser,
    session?: { activeOrganizationId?: string | null } | null,
  ): TestIdentity & { user: TUser }
}

export function createTestSessionRegistry(): TestSessionRegistry {
  const sessions = new Map<string, TestSession>()
  let fallback: AuthSessionResolver | undefined
  return {
    resolver: {
      api: {
        async getSession({ headers }) {
          const token = headers.get(TEST_SESSION_HEADER)
          if (token) return sessions.get(token) ?? null
          return fallback?.api.getSession({ headers }) ?? null
        },
      },
    },
    attach(app) {
      fallback = toAuthSessionResolver(app.auth as never)
    },
    mocked(headers) {
      const token = headers.get(TEST_SESSION_HEADER)
      return token ? sessions.get(token) : undefined
    },
    mock(user, session = null) {
      const token = crypto.randomUUID()
      sessions.set(token, { user, session })
      return {
        user,
        headers: new Headers({ [TEST_SESSION_HEADER]: token }),
      }
    },
  }
}

export function mockAuthSession<
  TUser extends { id: string; email: string; name?: string; role?: string },
>(
  app: BunderstackAppLike,
  resolver: (opts: { headers: Headers }) => Promise<{
    user: TUser
    session?: { activeOrganizationId?: string | null } | null
  } | null>,
): void {
  const auth = app.auth as unknown as AuthSessionResolverLike
  if (auth?.api) {
    auth.api.getSession = resolver as unknown as (opts: {
      headers: Headers
    }) => Promise<unknown>
  }
}

function cookieHeaders(response: Response): Headers {
  const values = response.headers.getSetCookie()
  const cookie = values
    .map((value) => value.split(';', 1)[0])
    .filter((value): value is string => Boolean(value))
    .join('; ')
  return new Headers(cookie ? { cookie } : undefined)
}

export function createTestAuth(app: {
  handler(request: Request): Promise<Response>
  auth: unknown
}, email: TestEmail, sessions: TestSessionRegistry): TestAuth {
  const request = async (
    path: string,
    init: RequestInit = {},
    headers?: Headers,
  ) => {
    const mergedHeaders = new Headers(headers)
    if (init.body !== undefined && !mergedHeaders.has('content-type')) {
      mergedHeaders.set('content-type', 'application/json')
    }
    return app.handler(
      new Request(new URL(path, 'http://bunderstack.test'), {
        ...init,
        headers: mergedHeaders,
      }),
    )
  }

  const identityFromResponse = async (response: Response) => {
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new TestAuthError(response.status, body)
    const user = (body as { user?: TestUser } | null)?.user
    if (!user) throw new TestAuthError(response.status, body)
    return { user, headers: cookieHeaders(response) }
  }

  const currentSession = async (
    identity: TestIdentity,
  ): Promise<TestSession | null> => {
    const mocked = sessions.mocked(identity.headers)
    if (mocked) return mocked
    const auth = app.auth as {
      api: {
        getSession(options: { headers: Headers }): Promise<unknown>
      }
    }
    const result = await auth.api.getSession({ headers: identity.headers })
    if (!result || typeof result !== 'object' || !('user' in result)) {
      return null
    }
    const value = result as { user?: TestUser; session?: TestSession['session'] }
    return value.user
      ? { user: value.user, session: value.session ?? null }
      : null
  }

  return {
    async signUpEmail(input) {
      return identityFromResponse(
        await request('/api/auth/sign-up/email', {
          method: 'POST',
          body: JSON.stringify({
            email: input.email,
            name: input.name,
            password: input.password ?? 'password-123',
          }),
        }),
      )
    },
    async signInEmail(input) {
      return identityFromResponse(
        await request('/api/auth/sign-in/email', {
          method: 'POST',
          body: JSON.stringify({
            email: input.email,
            password: input.password ?? 'password-123',
          }),
        }),
      )
    },
    async getSession(identity) {
      return currentSession(identity)
    },
    async signOut(identity) {
      const response = await request(
        '/api/auth/sign-out',
        { method: 'POST' },
        identity.headers,
      )
      if (!response.ok) {
        throw new TestAuthError(
          response.status,
          await response.json().catch(() => null),
        )
      }
    },
    async verifyEmail(identity) {
      const message = [...email.sent]
        .reverse()
        .find((candidate) => candidate.to.includes(identity.user.email))
      const content = `${message?.text ?? ''}\n${message?.html ?? ''}`
      const url = content.match(/https?:\/\/[^\s<>"']+\/api\/auth\/verify-email\?[^\s<>"']+/)?.[0]
      if (!url) {
        throw new Error(
          `[bunderstack] no verification link captured for ${identity.user.email}`,
        )
      }
      const response = await request(url, {}, identity.headers)
      if (response.status >= 400) {
        throw new TestAuthError(response.status, await response.text())
      }
      const user = (await currentSession(identity))?.user
      if (!user) {
        throw new Error('[bunderstack] verified identity has no active session')
      }
      return { user, headers: identity.headers }
    },
    mockSession(user, session) {
      return sessions.mock(user, session)
    },
  }
}
import type { AuthSessionResolver } from '../access'
import type { TestEmail } from './email'

import { toAuthSessionResolver } from '../auth'
