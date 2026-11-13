// An application laid out the way the docs say: the backend names its seed
// module with a lazy import, and the seed module imports the backend for its
// types. The pair must typecheck without the backend's type depending on
// itself; `tsc` over this directory is the test.
import * as v from 'valibot'

import { bunderstack } from '../backend'
import { libsql } from '../database/libsql'
import * as schema from './schema'

export const backend = bunderstack({
  schema,
  env: { server: { SEED_ADMIN_EMAIL: v.optional(v.string()) } },
  database: {
    adapter: libsql(),
    migrations: './migrations',
    seed: () => import('./seed'),
  },
})
