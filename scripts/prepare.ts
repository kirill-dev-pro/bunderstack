import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

// Skip during production installs (e.g. docker multi-stage deps cache) where devDependencies are omitted
if (process.env.NODE_ENV === 'production') {
  process.exit(0)
}

const typesBunPath = join(root, 'node_modules/@types/bun/package.json')
if (!(await Bun.file(typesBunPath).exists())) {
  process.exit(0)
}

const proc = Bun.spawn(['bun', 'run', 'build'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
