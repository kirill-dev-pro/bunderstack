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

import { loader, type VirtualFile } from 'fumadocs-core/source'

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
for (const page of source.getPages()) {
  paths[page.slugs.join('/')] = page.path
}

await Bun.write(outFile, JSON.stringify({ pageTree, paths }, null, 2))
console.log(
  `docs-manifest: ${Object.keys(paths).length} pages → src/lib/docs-manifest.gen.json`,
)
