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

export type TestAuth = {
  signUpEmail(input: SignUpEmailInput): Promise<TestIdentity>
  mockSession(user: TestUser): TestIdentity
}

export type AuthSessionResolverLike = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<unknown>
  }
}

export type BunderstackAppLike = {
  auth: unknown
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
}): TestAuth {
  return {
    async signUpEmail(input) {
      const response = await app.handler(
        new Request('http://bunderstack.test/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: input.email,
            name: input.name,
            password: input.password ?? 'password-123',
          }),
        }),
      )
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new TestAuthError(response.status, body)
      const user = (body as { user?: TestUser } | null)?.user
      if (!user) throw new TestAuthError(response.status, body)
      return { user, headers: cookieHeaders(response) }
    },
    mockSession(user) {
      mockAuthSession(app, async () => ({ user, session: null }))
      return { user, headers: new Headers() }
    },
  }
}
