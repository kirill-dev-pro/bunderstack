export type BunderstackLogLevel = 'info' | 'warn' | 'error'

export type BunderstackLogger = {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export const consoleLogger: BunderstackLogger = {
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}
