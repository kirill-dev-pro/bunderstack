import type { TelemetrySink } from './telemetry'

// Process-level failures on Bun. An uncaught exception is reported, flushed
// with a short limit, and then the process exits with code 1 exactly as Bun
// would have without a listener: the reporter never turns a crash into a
// silently running process. An unhandled rejection is reported and otherwise
// left to the runtime's own handling.

export function installProcessTelemetry(
  telemetry: TelemetrySink,
  proc: Pick<NodeJS.Process, 'on' | 'off' | 'listenerCount' | 'exit'> = process,
): () => void {
  const onException = (error: unknown) => {
    telemetry.captureException(error, {
      source: 'process',
      event: 'uncaughtException',
    })
    const others = proc.listenerCount('uncaughtException') - 1
    void Promise.race([
      telemetry.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]).finally(() => {
      if (others <= 0) {
        console.error(error)
        proc.exit(1)
      }
    })
  }
  const onRejection = (reason: unknown) => {
    telemetry.captureException(reason, {
      source: 'process',
      event: 'unhandledRejection',
    })
    void telemetry.flush()
  }
  proc.on('uncaughtException', onException)
  proc.on('unhandledRejection', onRejection)
  return () => {
    proc.off('uncaughtException', onException)
    proc.off('unhandledRejection', onRejection)
  }
}
