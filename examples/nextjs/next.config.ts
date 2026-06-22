import type { NextConfig } from 'next'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.dirname(fileURLToPath(import.meta.url))

const serverPackages = [
  'bunderstack',
  'drizzle-kit',
  '@libsql/client',
  'libsql',
  'drizzle-orm',
  'better-auth',
  'hono',
  'sharp',
]

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(rootDir, '../..'),
  serverExternalPackages: serverPackages,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals)
          ? config.externals
          : [config.externals]),
        ...serverPackages,
        /^@libsql\//,
      ]
    }
    return config
  },
}

export default nextConfig
