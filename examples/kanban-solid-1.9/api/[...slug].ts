import { defineHandler } from 'nitro'

import { app } from '../src/bunderstack.ts'

type BunResponse = Response & {
  _toNodeResponse?: (res: import('node:http').ServerResponse) => Promise<void>
}

async function toWebResponse(response: BunResponse): Promise<Response> {
  if (typeof response._toNodeResponse !== 'function') return response
  return new Response(await response.bytes(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export default defineHandler(async (event) =>
  toWebResponse(await app.handler(event.req)),
)
