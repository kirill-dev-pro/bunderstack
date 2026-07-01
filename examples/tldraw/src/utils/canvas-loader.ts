import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import { app } from '~/bunderstack'
import type { CanvasRow } from '~/utils/canvas-data'

export function buildCanvasFetchRequest(request: Request, id: string) {
  return new Request(new URL(`/api/canvas/${encodeURIComponent(id)}`, request.url), {
    headers: request.headers,
  })
}

export const fetchCanvas = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const request = getRequest()
    if (!request) return null

    const response = await app.handler(buildCanvasFetchRequest(request, id))
    if (!response.ok) return null

    return (await response.json()) as CanvasRow
  })
