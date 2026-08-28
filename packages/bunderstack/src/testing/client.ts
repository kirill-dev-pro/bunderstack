import type { AnyBunderstackApp, BunderstackClient } from '../client/rpc-client'
import type { TestIdentity } from './auth'

import { createClient } from '../client/rpc-client'

export function testClient<TApp extends AnyBunderstackApp>(
  app: TApp & { handler(request: Request): Promise<Response> },
  identity?: TestIdentity,
): BunderstackClient<TApp> {
  return createClient<TApp>({
    baseUrl: 'http://bunderstack.test/api',
    fetch: (input, init) => app.handler(new Request(input, init)),
    headers: identity?.headers,
  })
}
