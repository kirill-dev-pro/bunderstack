import { backend } from './bunderstack/backend'

const app = await backend.start({
  env: { ...process.env, BUNDERSTACK_ROLE: 'web' },
})

await app.runWorker()
