export type TransportFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export function createFetch(fetch?: TransportFetch): TransportFetch {
  return fetch ?? ((input, init) => globalThis.fetch(input, init))
}
