import type { ParentProps } from 'solid-js'

import { HydrationScript } from '@solidjs/web'

/**
 * The document shell — this replaces index.html. Start mode wraps the app in
 * it and injects the client entry script.
 *
 * `<HydrationScript />` is required in SSR mode: it emits the `_$HY` runtime
 * the streamed markup resumes from. Without it the page renders server-side
 * and then dies on hydration.
 *
 * Delete this file to fall back to the plugin's built-in shell.
 */
export default function Document(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Todo · Solid 2 + Bunderstack</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  )
}
