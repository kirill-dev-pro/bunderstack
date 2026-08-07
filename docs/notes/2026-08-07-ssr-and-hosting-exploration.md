# SSR, static hosting, and deployment targets — exploration notes

**Date:** 2026-08-07
**Status:** exploration only. No design approved, nothing implemented.
**Purpose:** hand-off to a future session. Self-contained; assumes no prior context.

These notes came out of a wider session about simplifying bunderstack. The other
thread from that session (collapsing cron into the jobs table) is being handled
separately and is not covered here beyond where it touches deployment.

---

## The starting complaint

Deployment currently goes through Bunderhost onto Fly Machines. Hosting a static
web application inside a Fly Machine is slow — you are paying for a VM to act as
a CDN, and the deploy cadence of the frontend is coupled to the deploy cadence of
the backend.

The idea being explored: serve the frontend from Cloudflare or S3-style object
storage with a cache in front, and leave only the API and background work on
actual compute.

---

## Current state (verified in-repo, 2026-08-07)

`templates/tanstack-start-saas` is a **server-rendered** app, not a static one:

- `vite.config.ts` uses the `tanstackStart()` plugin
- `package.json` `start` script boots `.output/server/index.mjs`
- `vite.config.ts` carries an SSR workaround:
  `ssr: { noExternal: [/^bunderstack/] }`, because bunderstack ships TypeScript
  sources that Vite must transform rather than hand to the Node resolver

**The critical finding:** the template's entire dependence on TanStack Start's
server functions is *one file, 17 lines* — `src/lib/session.ts`:

```ts
export const fetchUser = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionUser | null> => {
    const request = getRequest()
    if (!request) return null
    return await getSessionUser(app, request)
  },
)
```

That is the only `createServerFn` / `@tanstack/react-start/server` usage in the
whole template. Everything else is ordinary client-side React, TanStack Router,
tRPC, and bunderstack-sync.

So "how expensive is it to drop SSR?" has a surprisingly concrete answer: it is
concentrated almost entirely in the server-side session read.

---

## The proposal that came out of it

The instinct "use Astro, go fully static, no JavaScript" is directionally right
but should be split by **surface**, not applied uniformly:

| Surface | Needs JS? | Needs SSR? |
|---|---|---|
| Marketing / docs / pricing / blog | No | No — prerender, zero JS, perfect CDN cache |
| Dashboard (behind auth) | **Yes** — interactive, driven by bunderstack-sync live queries | **No** — per-user and uncacheable, so server rendering buys almost nothing |

The dashboard cannot be "no JavaScript" — it is an interactive app. But it does
not need *server rendering*, which is a different question that tends to get
conflated with it.

**Therefore both halves can ship as static files.** Marketing is prerendered
HTML. The app is a single static HTML shell plus a client router, with all data
arriving over tRPC/sync. Compute is then responsible only for the API and
background jobs.

### What dropping SSR buys

- Kills the entire "does this code run on the server or the client?" problem class
- Kills the `ssr.noExternal: [/^bunderstack/]` workaround in the template's Vite config
- Makes the deploy artifact literally *a bucket plus one process*
- Decouples deploy cadence — assets ship in seconds, compute rolls on its own schedule
  (this is the actual source of the original "Fly is slow" pain)

### What dropping SSR costs

- **No server-side auth redirect.** You get a loading flash before bouncing to
  login, instead of a server-rendered redirect. This is the main UX regression
  and it is exactly what `session.ts` currently provides.
- **SEO for anything behind the app shell.** Usually irrelevant for a dashboard;
  matters if any app route is meant to be indexed.
- **TanStack Start server functions go away.** Per the audit above, that is one
  function — but it is a load-bearing one.

---

## Astro specifically

Astro is a strong fit for the static/marketing half. It is not a fit for the app
half, which still needs a router — so choosing Astro means running **two
toolchains**.

- For a framework **template**, prefer one toolchain: prerendered TanStack Router
  for both halves. Less to explain, less to maintain, one build.
- Astro makes more sense when the marketing site is a genuinely separate product
  surface — for example bunderstack's own `website/`, which is already separate.

---

## Knock-on effect: `bunderstack-start`

`packages/bunderstack-start` describes itself as "TanStack Start integration for
bunderstack: isomorphic fetch wiring, auth client, and query/sync setup **for SSR
apps**." Its source is `auth-client.ts`, `isomorphic-fetch.ts`, `index.ts`.

If SSR goes away, most of this package's reason to exist goes with it — the
"isomorphic" fetch problem is an SSR problem. What likely survives is the auth
client. **Worth deciding explicitly** rather than letting the package linger with
a purpose that no longer matches its description.

---

## Connection to the Cloudflare-as-a-target question

If the app is static and the server is API-only, then the thing you would deploy
to a Cloudflare Worker is *just an API handler* — which makes Cloudflare a far
more realistic target than it first appears.

A coupling audit of `packages/*/src` (excluding tests) found the Bun-specific
surface is thinner than expected. Counts of Bun API usage:

| API | Uses | Assessment |
|---|---|---|
| `Bun.file` / `Bun.write` | 24 | Mostly CLI + blueprint generator (build-time, irrelevant at runtime) and the local storage driver |
| `Bun.Image` | 6 | **The real blocker.** `storage/thumbnails.ts`. No native image codec in a Worker. |
| `Bun.S3Client` | 4 | `storage/s3.ts` — already behind a storage driver seam; R2 binding or aws4fetch replaces it |
| `Bun.RedisClient` | 4 | `index.ts` realtime broker — disappears if realtime moves off Redis |
| `Bun.randomUUIDv7` | 4 | `typeid.ts` — trivially replaceable |
| `bun:sqlite` / `Bun.sql` | 6 | Already behind a dialect seam; libSQL over HTTP or Hyperdrive works |
| `Bun.serve` | 2 | Core is already a Web-standard `Request -> Response` handler |
| `Bun.resolveSync` | 1 | CLI only |

Options for the `Bun.Image` blocker: Cloudflare Images; or keep thumbnailing as a
background job that runs on a Bun machine; or drop thumbnails from the Cloudflare
profile.

**Strategic caveat worth carrying forward:** a second runtime target is the
*opposite* of simplification unless the core stays strictly Web-standard and every
platform difference lives behind the driver seams that already exist. The codebase
is roughly 80% there already, seemingly by accident. That discipline pays off even
if Cloudflare is never adopted.

---

## Open questions for the next session

1. Is the no-flash auth redirect worth keeping SSR for? If yes, is there a
   cheaper way — a cookie-readable session hint, an edge redirect at the CDN, a
   prerendered redirect shell?
2. What is the prerender story for TanStack Router without Start? Confirm it
   covers the marketing surface well enough to avoid pulling Astro in.
3. Does `bunderstack-start` survive, shrink to just the auth client, or get folded
   into another package?
4. One template or two — does the SaaS template ship marketing + app together, or
   does the framework take a position that they are separate deployables?
5. If Cloudflare becomes a target, is it a *supported profile* with its own driver
   set, or an example? Supported means committing to the Web-standard discipline
   in CI.

---

## Related

- The cron/jobs collapse thread from the same session makes the background half
  portable via a single `tick()` entry point (embedded loop, standalone worker, or
  an HTTP/`scheduled()`/`alarm()` wake). That work is what would let the compute
  half run on Cloudflare or scale to zero on Fly — it is a prerequisite for most
  of the deployment ideas above.
- `docs/superpowers/plans/2026-07-18-background-runtime-bunderhost.md` describes
  the current Fly Machines deployment topology (web + worker roles, scale-to-zero
  web, signed cron dispatch).
