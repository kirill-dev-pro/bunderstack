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

writeFileSync(join(clientDir, '.nojekyll'), '')
