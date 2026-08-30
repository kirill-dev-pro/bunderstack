import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const docsDirectory = join(root, 'website/content/docs')
const output = join(root, 'packages/bunderstack/llms-full.txt')

const sections = readdirSync(docsDirectory)
  .filter((name) => name.endsWith('.mdx'))
  .sort()
  .map((name) => {
    const source = readFileSync(join(docsDirectory, name), 'utf8')
    const frontmatter = /^---\n([\s\S]*?)\n---\n*/.exec(source)
    const title =
      /^title:\s*(.+)$/m.exec(frontmatter?.[1] ?? '')?.[1]?.trim() ?? name
    const body = source.slice(frontmatter?.[0].length ?? 0).trim()
    return `${title.toUpperCase()}\n\n${body}`
  })

writeFileSync(
  output,
  [
    'Bunderstack full documentation',
    '',
    'Generated from the canonical website documentation. The committed bunderstack.blueprint.yaml remains authoritative for an individual application.',
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n'),
)
