export class BunderstackApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown = undefined) {
    super(message)
    this.name = 'BunderstackApiError'
    this.status = status
    this.body = body
  }
}
