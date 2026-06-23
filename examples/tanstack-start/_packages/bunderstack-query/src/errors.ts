export class BunderstackApiError extends Error {
  readonly status: number
  readonly body: unknown
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, status: number, body: unknown = undefined) {
    super(message)
    this.name = 'BunderstackApiError'
    this.status = status
    this.body = body
    if (body && typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>
      if (typeof record.code === 'string') this.code = record.code
      if ('details' in record) this.details = record.details
    }
  }
}
