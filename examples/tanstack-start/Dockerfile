########################################
# Stage 1: Build
#
# Build context = examples/tanstack-start/ (Dokploy limitation).
# Workspace packages are vendored in _packages/ so no monorepo root is needed.
########################################
FROM oven/bun:1 AS builder

WORKDIR /app

COPY . .

# Swap workspace:* refs for local vendored paths so bun install can resolve them
RUN sed -i 's|"bunderstack": "workspace:\*"|"bunderstack": "file:./_packages/bunderstack"|' package.json \
    && sed -i 's|"bunderstack-query": "workspace:\*"|"bunderstack-query": "file:./_packages/bunderstack-query"|' package.json \
    && sed -i 's|"bunderstack": "workspace:\*"|"bunderstack": "file:../bunderstack"|' _packages/bunderstack-query/package.json

RUN bun install

RUN bun run build

########################################
# Stage 2: Runtime
########################################
FROM oven/bun:1

WORKDIR /app

COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/_packages ./_packages
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/src/schema.ts ./src/schema.ts

EXPOSE 3000

CMD ["sh", "-c", \
    "./node_modules/.bin/drizzle-kit push --config=drizzle.config.ts && \
    bun .output/server/index.mjs"]
