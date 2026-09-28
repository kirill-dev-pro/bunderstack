// The child processes of `bunderstack dev`: one log with a prefix per process,
// and one stop for all of them.
import type { Subprocess } from 'bun'

export type ProcessSpec = {
  name: string
  cmd: string[]
  cwd: string
  env?: Record<string, string>
  /** Rewrites an output line; `undefined` drops it. */
  filter?: (line: string) => string | undefined
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
    this.width = Math.max(this.width, spec.name.length)
    const child = Bun.spawn(spec.cmd, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdin: 'ignore',
      // Own process group, so stop() reaches the child's children too.
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.children.push(child)
    const emit = (line: string) => {
      const shown = spec.filter ? spec.filter(line) : line
      if (shown !== undefined) this.log(spec.name, shown)
    }
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      let pending = ''
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const result = prefixLines(chunk, pending)
        pending = result.pending
        for (const line of result.lines) emit(line)
      }
      if (pending) emit(pending)
    }
    const output = Promise.all([pump(child.stdout), pump(child.stderr)])
    void child.exited.then(async (code) => {
      await output.catch(() => {})
      if (!this.stopping) this.resolveExit({ name: spec.name, code })
    })
  }

  /**
   * SIGINT to each child's process group, as Ctrl+C in a terminal does, then
   * SIGKILL to the groups after 3 s. `celld dev` runs a node process that
   * ignores SIGTERM, so a signal to the leader alone leaves it running.
   */
  async stop() {
    this.stopping = true
    const signal = (sig: NodeJS.Signals) => {
      for (const child of this.children) {
        try {
          process.kill(-child.pid, sig)
        } catch {
          // The group is gone already.
        }
      }
    }
    signal('SIGINT')
    await Promise.race([
      Promise.allSettled(this.children.map((child) => child.exited)),
      Bun.sleep(3_000),
    ])
    signal('SIGKILL')
    await Promise.allSettled(this.children.map((child) => child.exited))
  }
}
