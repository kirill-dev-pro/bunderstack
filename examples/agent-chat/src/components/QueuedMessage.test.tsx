import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { QueuedMessage } from './QueuedMessage'

test('an ephemeral queued message exposes interrupt and remove controls', () => {
  const html = renderToStaticMarkup(
    <QueuedMessage
      message={{
        clientMessageId: 'local-1',
        content: 'Please answer this next',
        mode: 'after-current',
      }}
      onInterrupt={() => {}}
      onRemove={() => {}}
    />,
  )

  expect(html).toContain('Queued in this tab')
  expect(html).toContain('Please answer this next')
  expect(html).toContain('Send now')
  expect(html).toContain('Remove from queue')
})
