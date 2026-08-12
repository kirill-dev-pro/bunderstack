import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../dist/client',
)
const shell = join(clientDir, '_shell.html')
const index = join(clientDir, 'index.html')

if (existsSync(shell)) {
  copyFileSync(shell, index)
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

writeFileSync(join(clientDir, '.nojekyll'), '')
