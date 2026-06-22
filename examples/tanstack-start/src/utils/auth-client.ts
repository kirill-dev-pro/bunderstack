import { createAuthClient } from 'better-auth/react'

// Client-side BetterAuth SDK. Calls /api/auth/* which is served by
// the Bunderstack handler mounted at src/routes/api/$.tsx.
export const authClient = createAuthClient({
  baseURL: typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000',
})
