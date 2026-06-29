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

# Build the Twitter TanStack app
WORKDIR /repo/examples/twitter-tanstack
RUN bun run build

########################################
# Stage 2: Runtime
########################################
FROM oven/bun:1

WORKDIR /app


# Bundled Nitro server output
COPY --from=builder /repo/examples/twitter-tanstack/.output ./.output

# Workspace packages (bunderstack is SSR-external so Nitro may not bundle it)
COPY --from=builder /repo/packages ./packages

# Hoisted node_modules (drizzle-kit, drizzle-orm, etc. live under .bun/)
COPY --from=builder /repo/node_modules ./node_modules

# Example workspace layout so bun run db:migrate resolves drizzle-kit + bunderstack
COPY --from=builder /repo/examples/twitter-tanstack/package.json ./examples/twitter-tanstack/package.json
COPY --from=builder /repo/examples/twitter-tanstack/node_modules ./examples/twitter-tanstack/node_modules
COPY --from=builder /repo/examples/twitter-tanstack/drizzle.config.ts ./examples/twitter-tanstack/drizzle.config.ts
COPY --from=builder /repo/examples/twitter-tanstack/migrations/ ./examples/twitter-tanstack/migrations/
COPY --from=builder /repo/examples/twitter-tanstack/scripts/ ./examples/twitter-tanstack/scripts/
COPY --from=builder /repo/examples/twitter-tanstack/src/ ./examples/twitter-tanstack/src/
COPY --from=builder /repo/examples/twitter-tanstack/tsconfig.json ./examples/twitter-tanstack/tsconfig.json

EXPOSE 3000

ENV NODE_ENV=production

# Apply migrations then start the server
CMD ["sh", "-c", "cd examples/twitter-tanstack && bun run db:migrate && cd /app && bun .output/server/index.mjs"]
