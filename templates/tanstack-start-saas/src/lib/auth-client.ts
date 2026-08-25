import { createStartAuthClient } from 'bunderstack/start/auth'

export const authClient = createStartAuthClient()
export const { useSession, signIn, signUp, signOut } = authClient
