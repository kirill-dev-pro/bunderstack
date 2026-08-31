import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { StreamingMessage } from './StreamingMessage'

const baseMessage = {
  id: 'amsg_one',
  content: 'Hello **world**',
  status: 'streaming',
  revision: 2,
}

test('a running assistant message renders markdown and a stop action', () => {
  const html = renderToStaticMarkup(
    <StreamingMessage
      message={baseMessage}
      run={{ id: 'arun_one', status: 'running', error: null }}
      steps={[]}
      onStop={() => {}}
    />,
  )

  expect(html).toContain('<strong>world</strong>')
  expect(html).toContain('Stop')
  expect(html).toContain('aria-label="Streaming answer"')
})

test('a cancelled partial answer remains visible with a terminal note', () => {
  const html = renderToStaticMarkup(
    <StreamingMessage
      message={{ ...baseMessage, status: 'cancelled' }}
      run={{ id: 'arun_one', status: 'cancelled', error: null }}
      steps={[]}
      onStop={() => {}}
    />,
  )

  expect(html).toContain('Hello')
  expect(html).toContain('Stopped by user')
  expect(html).not.toContain('>Stop<')
})

test('an errored answer explains that its partial text was preserved', () => {
  const html = renderToStaticMarkup(
    <StreamingMessage
      message={{ ...baseMessage, status: 'error' }}
      run={{ id: 'arun_one', status: 'error', error: 'Provider unavailable' }}
      steps={[]}
      onStop={() => {}}
    />,
  )

  expect(html).toContain('Provider unavailable')
  expect(html).toContain('Partial answer preserved')
})
