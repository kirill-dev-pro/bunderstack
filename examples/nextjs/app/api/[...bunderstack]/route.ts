import { getApp } from '../../../bunderstack'

async function handle(req: Request) {
  const app = await getApp()
  return app.handler(req)
}

export const GET = handle
export const POST = handle
export const PATCH = handle
export const DELETE = handle
