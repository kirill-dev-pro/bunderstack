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
const siteUrl = 'https://bunderstack.dev'
const sitemapPages = [
  { loc: `${siteUrl}/`, priority: '1.0', changefreq: 'weekly' },
  ...Object.keys(paths).map((slug) => ({
    loc: slug ? `${siteUrl}/docs/${slug}` : `${siteUrl}/docs`,
    priority: slug === '' || slug === 'getting-started' ? '0.9' : '0.8',
    changefreq: 'weekly',
  })),
]

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapPages
  .map(
    (p) => `  <url>
    <loc>${p.loc}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`,
  )
  .join('\n')}
</urlset>
`

await Bun.write(join(root, 'public/sitemap.xml'), sitemapXml)

// Generate robots.txt
const robotsTxt = `User-agent: *
Allow: /

Sitemap: ${siteUrl}/sitemap.xml
`
await Bun.write(join(root, 'public/robots.txt'), robotsTxt)
console.log('seo: generated public/sitemap.xml & public/robots.txt')
