########################################
# Stage 1: Build
########################################
FROM oven/bun:1 AS builder

WORKDIR /repo

# Install monorepo dependencies
COPY package.json bun.lock ./
COPY packages/ ./packages/
COPY examples/ ./examples/

RUN bun install --frozen-lockfile

# Build the TanStack Start app
WORKDIR /repo/examples/tanstack-start
RUN bun run build

########################################
# Stage 2: Runtime
########################################
FROM oven/bun:1

WORKDIR /app

# Bundled Nitro server output
COPY --from=builder /repo/examples/tanstack-start/.output ./.output

# Workspace packages (bunderstack is SSR-external so Nitro may not bundle it)
COPY --from=builder /repo/packages ./packages

# Hoisted node_modules (drizzle-kit, drizzle-orm, etc. live under .bun/)
COPY --from=builder /repo/node_modules ./node_modules

# Example workspace layout so bun run db:push resolves drizzle-kit + bunderstack
COPY --from=builder /repo/examples/tanstack-start/package.json ./examples/tanstack-start/package.json
COPY --from=builder /repo/examples/tanstack-start/node_modules ./examples/tanstack-start/node_modules
COPY --from=builder /repo/examples/tanstack-start/drizzle.config.ts ./examples/tanstack-start/drizzle.config.ts
COPY --from=builder /repo/examples/tanstack-start/src/schema.ts ./examples/tanstack-start/src/schema.ts

EXPOSE 3000

ENV NODE_ENV=production

# Push schema then start the server
CMD ["sh", "-c", "cd examples/tanstack-start && bun run db:push && cd /app && bun .output/server/index.mjs"]
