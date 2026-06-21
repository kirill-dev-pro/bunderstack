import { createBunderstack } from '../../src/index'
import * as schema from '../standalone/schema'

export const app = createBunderstack({
  schema,
  auth: { emailPassword: true },
  storage: { local: './.uploads' },
})
