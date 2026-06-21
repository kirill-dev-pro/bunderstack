import { StartClient } from '@tanstack/start'
import { createRouter } from './router'

const router = createRouter()
StartClient({ router })
