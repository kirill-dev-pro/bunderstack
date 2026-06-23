########################################
# Stage 1: Build
########################################
FROM oven/bun:1 AS builder

WORKDIR /repo

# Install monorepo dependencies
COPY package.json bun.lock ./
COPY packages/ ./packages/
COPY examples/tanstack-start/ ./examples/tanstack-start/

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

# Hoisted node_modules (includes drizzle-kit, drizzle-orm, bunderstack deps)
COPY --from=builder /repo/node_modules ./node_modules

# Files required for drizzle-kit push on startup
COPY --from=builder /repo/examples/tanstack-start/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /repo/examples/tanstack-start/src/schema.ts ./src/schema.ts

EXPOSE 3000

# Push schema then start the server
CMD ["sh", "-c", "./node_modules/.bin/drizzle-kit push --config=drizzle.config.ts && bun .output/server/index.mjs"]
