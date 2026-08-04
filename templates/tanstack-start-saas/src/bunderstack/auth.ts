/**
 * Better Auth configuration, passed to `createBunderstack({ auth })`.
 *
 * This module reads `process.env` at module scope on purpose. Importing the
 * Bunderstack entry from here would create a circular evaluation loop at boot,
 * because the entry imports this config.
 */
export const authConfig = {
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:5173',
  secret: process.env.AUTH_SECRET ?? 'dev-secret-change-before-production',
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      // Server-owned. Never in the browser's write path; the admin dashboard
      // reads it through a procedure that checks it on the server.
      role: {
        type: 'string' as const,
        required: false,
        defaultValue: 'user',
        input: false,
      },
    },
  },
  advanced: {
    database: {
      // Bunderstack's typeid column defaults own id generation.
      generateId: false as const,
    },
  },
}
