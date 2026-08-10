export type RequestFetch = (request: Request) => Promise<Response>
export type TransportFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export function createFetch(fetch?: RequestFetch): TransportFetch {
  if (!fetch) return (input, init) => globalThis.fetch(input, init)

  return (input: RequestInfo | URL, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(input.toString(), 'http://localhost'), init)
    return fetch(request)
  }
}
