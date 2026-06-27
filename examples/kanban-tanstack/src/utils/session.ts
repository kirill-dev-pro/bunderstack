import { eq } from 'drizzle-orm'
import { getRequest } from '@tanstack/react-start/server'

import { app, db } from '~/bunderstack'
import * as schema from '~/schema'

export async function getAuthSession() {
  const request = getRequest()
  if (!request) return null
  return app.auth.api.getSession({ headers: request.headers })
}

/** Pick the user's first org when session has no activeOrganizationId (SSR-safe). */
export async function ensureActiveOrganization() {
  const session = await getAuthSession()
  if (!session?.user || session.session.activeOrganizationId) return

  const [member] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, session.user.id))
    .limit(1)

  if (!member?.organizationId) return

  await db
    .update(schema.session)
    .set({ activeOrganizationId: member.organizationId })
    .where(eq(schema.session.id, session.session.id))
}
