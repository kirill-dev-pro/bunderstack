// Compile-time contract for the public Better Auth instance. `tsc` is the
// assertion runner: every property access below must remain valid.
import { admin, organization } from 'better-auth/plugins'
import { twoFactor } from 'better-auth/plugins/two-factor'
import * as v from 'valibot'

import { bunderstack } from './backend'
import { defineAuth } from './config'

const database = { adapter: null as never }

const staticAuth = defineAuth({
  plugins: [admin(), organization()],
})
const staticBackend = bunderstack({ schema: {}, database, auth: staticAuth })
type StaticApp = Awaited<ReturnType<typeof staticBackend.start>>

declare const staticApp: StaticApp
void staticApp.auth.api.listUsers
void staticApp.auth.api.getFullOrganization
// Bunderstack installs OpenAPI when an application did not declare it.
void staticApp.auth.api.generateOpenAPISchema

async function assertAdminSessionRole(app: StaticApp) {
  const session = await app.auth.api.getSession({ headers: new Headers() })
  if (session && 'user' in session) void session.user.role
}
void assertAdminSessionRole

const envSchema = { server: { AUTH_SECRET: v.string() } }
const factoryAuth = defineAuth({ schema: {}, env: envSchema }, ({ env }) => ({
  secret: env.AUTH_SECRET,
  plugins: [twoFactor()],
}))
const factoryBackend = bunderstack({
  schema: {},
  env: envSchema,
  database,
  auth: factoryAuth,
})
type FactoryApp = Awaited<ReturnType<typeof factoryBackend.start>>

declare const factoryApp: FactoryApp
void factoryApp.auth.api.enableTwoFactor
