import { createBunderstack, type BunderstackApp } from 'bunderstack'

import * as schema from '../standalone/schema'

let appPromise: Promise<BunderstackApp<typeof schema>> | null = null

export function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const app = createBunderstack({
        schema,
        database: { url: 'file:./data.db' },
        auth: { emailAndPassword: { enabled: true } },
        access: { posts: { ownerColumn: 'authorId' } },
        storage: {
          local: './uploads',
          defaultBucket: 'default',
          buckets: { default: {} },
        },
      })
      await app.provision()
      return app
    })()
  }
  return appPromise
}
