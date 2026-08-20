########################################
# Stage 1: Build the static site
########################################
FROM oven/bun:1 AS builder

WORKDIR /repo

# Root install first: gen-code-snippets.ts resolves bunderstack packages from
# ../packages/*/src, whose imports (drizzle-orm, better-auth, hono,
# @tanstack/db, …) live in the root workspace node_modules. Without it,
# twoslash silently renders every hover as `any`.
COPY package.json bun.lock ./
COPY packages/ ./packages/
RUN bun install

# The website keeps its own lockfile — it is not a workspace member.
COPY website/ ./website/

WORKDIR /repo/website
# GITHUB_PAGES stays unset, so the site is built for `/`, not `/bunderstack/`.
RUN bun install && bun run build

########################################
# Stage 2: Serve with nginx
########################################
FROM nginx:alpine

COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/website/dist/client /usr/share/nginx/html

EXPOSE 80
