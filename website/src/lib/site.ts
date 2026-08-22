/**
 * Every absolute URL the site emits — canonical links, Open Graph images, the
 * sitemap, robots.txt — resolves against one origin. Build scripts import the
 * same constants, so a domain move is a single env var and nothing rots.
 *
 * Override with VITE_SITE_URL at build time. Vite inlines it into the client
 * bundle, and Bun exposes the same variable on import.meta.env, so the
 * generator scripts read one value with the site.
 */
const DEFAULT_SITE_URL = 'https://bunderstack.kcrz.dev'

export const SITE_URL = (
  import.meta.env?.VITE_SITE_URL || DEFAULT_SITE_URL
).replace(/\/+$/, '')

export const SITE_NAME = 'bunderstack'
export const SITE_TITLE =
  'bunderstack — Your whole backend as a single file declaration'
export const SITE_DESCRIPTION =
  'Declare database, auth, CRUD, storage, jobs, email, and realtime in one TypeScript file. Batteries-included backend framework for Bun, built on Drizzle, BetterAuth, and oRPC.'
export const SITE_SOCIAL_DESCRIPTION =
  'Database, auth, CRUD, storage, jobs, email, and realtime are keys on one object, and bun run dev starts all of it.'

export const GITHUB_URL = 'https://github.com/kirill-dev-pro/bunderstack'
export const NPM_URL = 'https://www.npmjs.com/package/bunderstack'

/** Social scrapers need absolute URLs; relative ones are silently dropped. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * PNG, not the smaller WebP: LinkedIn and several chat clients still refuse
 * WebP card images and fall back to no preview at all.
 */
export const OG_IMAGE = {
  url: absoluteUrl('/og.png'),
  type: 'image/png',
  width: '1200',
  height: '630',
  alt: 'bunderstack — your whole backend as a single file declaration',
} as const
