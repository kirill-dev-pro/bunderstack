import { loader, type VirtualFile } from 'fumadocs-core/source'
/**
 * Generates src/lib/docs-manifest.gen.json: the serialized page tree and the
 * slug→file mapping for the docs route. Runs before dev/build (see package
 * scripts).
 *
 * Why this exists: the docs route loader must be pure so client-side
 * navigation never calls a server function — GitHub Pages is a static host,
 * and `/_serverFn/...` RPCs 404 there. The tree/paths are build-time-known,
 * so we bake them. Using fumadocs-core's own `loader()`/`serializePageTree()`
 * guarantees the JSON matches what `useFumadocsLoader` deserializes.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '../src/lib/site'

const root = join(import.meta.dir, '..')
const contentDir = join(root, 'content/docs')
const outFile = join(root, 'src/lib/docs-manifest.gen.json')

/** Frontmatter here is flat `key: string` pairs — parse just that, loudly. */
function parseFrontmatter(text: string, file: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!match?.[1]) throw new Error(`${file}: missing frontmatter block`)
  const data: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue
    const idx = line.indexOf(':')
    if (idx === -1 || /^\s/.test(line)) {
      throw new Error(
        `${file}: frontmatter line ${JSON.stringify(line)} is not a flat "key: value" pair — extend gen-docs-manifest.ts`,
      )
    }
    const key = line.slice(0, idx).trim()
    data[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
  }
  return data
}

const files: VirtualFile[] = []
for (const entry of (await readdir(contentDir)).sort()) {
  if (entry.endsWith('.mdx') || entry.endsWith('.md')) {
    const text = await Bun.file(join(contentDir, entry)).text()
    const { title, description } = parseFrontmatter(text, entry)
    files.push({ type: 'page', path: entry, data: { title, description } })
  } else if (entry === 'meta.json') {
    const data = await Bun.file(join(contentDir, entry)).json()
    files.push({ type: 'meta', path: entry, data })
  }
}

const source = loader({ baseUrl: '/docs', source: { files } })
const pageTree = await source.serializePageTree(source.getPageTree())
const paths: Record<string, string> = {}
const pagesMeta: Record<string, { title: string; description: string }> = {}
for (const page of source.getPages()) {
  const slug = page.slugs.join('/')
  paths[slug] = page.path
  pagesMeta[slug] = {
    title: (page.data as any).title ?? 'Documentation',
    description: (page.data as any).description ?? '',
  }
}

await Bun.write(
  outFile,
  JSON.stringify({ pageTree, paths, pagesMeta }, null, 2),
)
console.log(
  `docs-manifest: ${Object.keys(paths).length} pages → src/lib/docs-manifest.gen.json`,
)

// Generate sitemap.xml
// `lastmod` comes from the last commit that touched the page, so a rebuild of
// unchanged content does not tell crawlers the whole site changed today.
function lastModified(file: string): string {
  const git = Bun.spawnSync([
    'git',
    'log',
    '-1',
    '--format=%cI',
    '--',
    join(contentDir, file),
  ])
  const iso = git.success ? git.stdout.toString().trim() : ''
  if (iso) return iso.slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

const docEntries = Object.entries(paths)
  .map(([slug, file]) => ({
    loc: slug ? `${SITE_URL}/docs/${slug}` : `${SITE_URL}/docs`,
    lastmod: lastModified(file),
    priority: slug === '' || slug === 'getting-started' ? '0.9' : '0.8',
    changefreq: 'weekly',
  }))
  .sort((a, b) => a.loc.localeCompare(b.loc))

const sitemapPages = [
  {
    loc: `${SITE_URL}/`,
    lastmod: new Date().toISOString().slice(0, 10),
    priority: '1.0',
    changefreq: 'weekly',
  },
  ...docEntries,
]

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapPages
  .map(
    (p) => `  <url>
    <loc>${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`

await Bun.write(join(root, 'public/sitemap.xml'), sitemapXml)

// Generate robots.txt. The search endpoint returns a JSON index, not a page —
// keeping it out of the crawl budget costs nothing and avoids a junk result.
const robotsTxt = `User-agent: *
Allow: /
Disallow: /api/

# Condensed documentation for LLM agents: ${SITE_URL}/llms.txt

Sitemap: ${SITE_URL}/sitemap.xml
`
await Bun.write(join(root, 'public/robots.txt'), robotsTxt)

// Generate site.webmanifest — installability plus a defined icon set for
// Android/Chrome, which otherwise upscales the favicon.
const webmanifest = {
  name: SITE_NAME,
  short_name: SITE_NAME,
  description: SITE_DESCRIPTION,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#050608',
  theme_color: '#050608',
  icons: [
    { src: '/logo-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/logo.png', sizes: '512x512', type: 'image/png' },
    {
      src: '/logo.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
}
await Bun.write(
  join(root, 'public/site.webmanifest'),
  `${JSON.stringify(webmanifest, null, 2)}\n`,
)
console.log(
  'seo: generated public/sitemap.xml, public/robots.txt & public/site.webmanifest',
)
