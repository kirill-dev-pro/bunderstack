import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const websiteDir = join(root, 'website')
const publicDir = join(websiteDir, 'public')
const read = (path: string) => readFileSync(join(publicDir, path), 'utf8')

/**
 * The site once published canonical links, an og:image and a sitemap pointing
 * at a domain that did not resolve — which tells search engines the live pages
 * are copies of something that does not exist, and leaves every social preview
 * blank. One constant now feeds all of it; these tests pin that it stays that
 * way, because nothing in a build fails when the origin is wrong.
 */
const siteSource = readFileSync(join(websiteDir, 'src/lib/site.ts'), 'utf8')
const siteUrl = /DEFAULT_SITE_URL = '([^']+)'/.exec(siteSource)?.[1]

describe('website SEO contract', () => {
  test('the canonical origin is a single absolute https origin', () => {
    expect(siteUrl).toMatch(/^https:\/\/[a-z0-9.-]+$/)
  })

  test('generated robots.txt points crawlers at the live sitemap', () => {
    const robots = read('robots.txt')

    expect(robots).toContain(`Sitemap: ${siteUrl}/sitemap.xml`)
    expect(robots).toContain('Allow: /')
    // The search index is JSON, not a page.
    expect(robots).toContain('Disallow: /api/')
  })

  test('the sitemap lists every docs page on the canonical origin', () => {
    const sitemap = read('sitemap.xml')
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!)
    const slugs = readdirSync(join(websiteDir, 'content/docs'))
      .filter((file) => file.endsWith('.mdx'))
      .map((file) => file.replace(/\.mdx$/, ''))

    expect(locs).toContain(`${siteUrl}/`)
    for (const slug of slugs) {
      const expected =
        slug === 'index' ? `${siteUrl}/docs` : `${siteUrl}/docs/${slug}`
      expect(locs).toContain(expected)
    }
    for (const loc of locs) expect(loc.startsWith(`${siteUrl}/`)).toBe(true)
    // Stale dates are worse than none: every entry carries an ISO day.
    expect(
      sitemap.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g)?.length,
    ).toBe(locs.length)
  })

  test('the social card is a 1200x630 PNG that the meta tags reference', () => {
    const og = readFileSync(join(publicDir, 'og.png'))

    // PNG IHDR: width and height are big-endian uint32 at bytes 16 and 20.
    expect(og.readUInt32BE(16)).toBe(1200)
    expect(og.readUInt32BE(20)).toBe(630)
    // WebP cards are dropped by LinkedIn and several chat clients.
    expect(siteSource).toContain("absoluteUrl('/og.png')")
  })

  test('every icon the web manifest declares exists', () => {
    const manifest = JSON.parse(read('site.webmanifest')) as {
      icons: Array<{ src: string }>
      start_url: string
    }

    expect(manifest.start_url).toBe('/')
    for (const icon of manifest.icons) {
      expect(existsSync(join(publicDir, icon.src))).toBe(true)
    }
  })

  test('routes take their absolute URLs from the shared constant', () => {
    const routes = ['src/routes/__root.tsx', 'src/routes/index.tsx']
      .concat('src/routes/docs/$.tsx')
      .map((path) => readFileSync(join(websiteDir, path), 'utf8'))

    for (const source of routes) {
      expect(source).toContain("from '@/lib/site'")
      expect(source).not.toMatch(/href: 'https:\/\//)
    }
  })
})
