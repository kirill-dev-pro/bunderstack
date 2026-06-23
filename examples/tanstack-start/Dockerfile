########################################
# Stage 1: Fetch monorepo workspace packages
#
# Dokploy sets the build context to the directory containing docker-compose.yml
# (examples/tanstack-start/), so packages/ at the repo root is unreachable.
# We sparse-clone only the packages/ dir from the same repo to work around this.
########################################
FROM alpine/git:latest AS mono-packages

ARG REPO_URL=https://github.com/kirill-dev-pro/bunderstack.git
ARG REPO_BRANCH=main

RUN git clone --depth=1 --filter=blob:none --sparse \
        --branch="${REPO_BRANCH}" "${REPO_URL}" /repo \
    && cd /repo \
    && git sparse-checkout set packages package.json bun.lock

########################################
# Stage 2: Build
########################################
FROM oven/bun:1 AS builder

WORKDIR /repo

# Monorepo root from sparse clone
COPY --from=mono-packages /repo/package.json ./package.json
COPY --from=mono-packages /repo/bun.lock ./bun.lock
COPY --from=mono-packages /repo/packages ./packages

# Example source (build context = examples/tanstack-start/)
COPY . ./examples/tanstack-start/

RUN bun install

WORKDIR /repo/examples/tanstack-start
RUN bun run build

########################################
# Stage 3: Runtime
########################################
FROM oven/bun:1

WORKDIR /app

COPY --from=builder /repo/examples/tanstack-start/.output ./.output
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/examples/tanstack-start/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /repo/examples/tanstack-start/src/schema.ts ./src/schema.ts

EXPOSE 3000

CMD ["sh", "-c", \
    "./node_modules/.bin/drizzle-kit push --config=drizzle.config.ts && \
    bun .output/server/index.mjs"]
