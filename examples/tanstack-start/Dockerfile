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
RUN bun --eval "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies['bunderstack'] = 'file:./_packages/bunderstack';
pkg.dependencies['bunderstack-query'] = 'file:./_packages/bunderstack-query';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
const qPkg = JSON.parse(fs.readFileSync('_packages/bunderstack-query/package.json', 'utf8'));
qPkg.dependencies['bunderstack'] = 'file:../bunderstack';
fs.writeFileSync('_packages/bunderstack-query/package.json', JSON.stringify(qPkg, null, 2));
"

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
