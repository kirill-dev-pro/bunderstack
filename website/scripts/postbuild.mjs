import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/client',
)
const shell = join(clientDir, '_shell.html')
const index = join(clientDir, 'index.html')

// The landing page is prerendered into index.html with its full markup and
// head. Overwriting it with the empty SPA shell would hand crawlers a blank
// body, so the shell only fills in when the prerender did not produce one.
// Unknown paths fall back to _shell.html (see nginx.conf) and 404.html
// (GitHub Pages), which both boot the client router.
if (existsSync(shell)) {
  // The shell is only ever served as a 404 body (see nginx.conf), so it must
  // not invite indexing. The tag is patched here because a `robots` entry in
  // the shell route's `head` drops the root's tag without emitting its own.
  const noindexed = readFileSync(shell, 'utf8').replace(
    /<meta name="robots" content="[^"]*"\s*\/?>/,
    '<meta name="robots" content="noindex, follow"/>',
  )
  if (!noindexed.includes('content="noindex, follow"')) {
    throw new Error('postbuild: no robots meta to patch in _shell.html')
  }
  writeFileSync(shell, noindexed)
  if (!existsSync(index)) writeFileSync(index, noindexed)
  writeFileSync(join(clientDir, '404.html'), noindexed)
}

// Served at /llms.txt. The package ships the same file, so an agent reading
// node_modules and an agent fetching the site get identical content.
const llms = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/bunderstack/llms.txt',
)
if (!existsSync(llms)) {
  throw new Error('postbuild: packages/bunderstack/llms.txt is missing')
}
copyFileSync(llms, join(clientDir, 'llms.txt'))

const llmsFull = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/bunderstack/llms-full.txt',
)
if (!existsSync(llmsFull)) {
  throw new Error('postbuild: packages/bunderstack/llms-full.txt is missing')
}
copyFileSync(llmsFull, join(clientDir, 'llms-full.txt'))

writeFileSync(join(clientDir, '.nojekyll'), '')
