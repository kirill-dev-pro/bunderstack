// The child processes of `bunderstack dev`: one log with a prefix per process,
// and one stop for all of them.
import type { Subprocess } from 'bun'

export type ProcessSpec = {
  name: string
  cmd: string[]
  cwd: string
  env?: Record<string, string>
}

const COLORS = [36, 35, 33, 32, 34]

export function prefixLines(
  chunk: string,
  pending: string,
): { lines: string[]; pending: string } {
  const parts = (pending + chunk).split(/\r?\n/)
  const rest = parts.pop() ?? ''
  return { lines: parts, pending: rest }
}

export class ProcessGroup {
  readonly exited: Promise<{ name: string; code: number | null }>
  private children: Subprocess[] = []
  private resolveExit!: (value: { name: string; code: number | null }) => void
  private stopping = false
  private width = 0

  constructor(
    private write: (line: string) => void = (line) => console.log(line),
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
  }

  private label(name: string) {
    const text = `[${name}]`.padEnd(this.width + 2)
    if (!process.stdout.isTTY) return text
    const color = COLORS[this.labelIndex(name) % COLORS.length]
    return `\x1b[${color}m${text}\x1b[0m`
  }

  private names: string[] = []
  private labelIndex(name: string) {
    if (!this.names.includes(name)) this.names.push(name)
    return this.names.indexOf(name)
  }

  /** Writes one line with the name's prefix; the dev command logs here too. */
  log(name: string, line: string) {
    this.labelIndex(name)
    this.width = Math.max(this.width, name.length)
    this.write(`${this.label(name)} ${line}`)
  }

  start(spec: ProcessSpec) {
    const child = Bun.spawn(spec.cmd, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.children.push(child)
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      let pending = ''
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const result = prefixLines(chunk, pending)
        pending = result.pending
        for (const line of result.lines) this.log(spec.name, line)
      }
      if (pending) this.log(spec.name, pending)
    }
    const output = Promise.all([pump(child.stdout), pump(child.stderr)])
    void child.exited.then(async (code) => {
      await output.catch(() => {})
      if (!this.stopping) this.resolveExit({ name: spec.name, code })
    })
  }

  async stop() {
    this.stopping = true
    const running = this.children.filter((child) => child.exitCode === null)
    for (const child of running) child.kill('SIGTERM')
    const timer = setTimeout(() => {
      for (const child of running) child.kill('SIGKILL')
    }, 3_000)
    await Promise.allSettled(running.map((child) => child.exited))
    clearTimeout(timer)
  }
}
