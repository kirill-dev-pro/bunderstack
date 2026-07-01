import { createStartAuthClient } from 'bunderstack-start'

// Client-side BetterAuth SDK. Calls /api/auth/* which is served by
// the Bunderstack handler mounted at src/routes/api/$.tsx.
export const authClient = createStartAuthClient()
