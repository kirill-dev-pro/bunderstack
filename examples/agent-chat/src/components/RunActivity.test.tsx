import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { RunActivity } from './RunActivity'

const steps = [
  {
    id: 'astep_one',
    sequence: 1,
    kind: 'retrieval',
    title: 'Search the web',
    status: 'complete',
    visibility: 'visible',
    input: { query: 'durable chat' },
    output: { matches: 3 },
    startedAt: new Date('2026-08-30T10:00:00.000Z'),
    completedAt: new Date('2026-08-30T10:00:01.250Z'),
  },
]

test('activity is expanded while the agent has not started its answer', () => {
  const html = renderToStaticMarkup(
    <RunActivity steps={steps} hasAnswer={false} runStatus="running" />,
  )

  expect(html).toContain('open=""')
  expect(html).toContain('Search the web')
  expect(html).toContain('durable chat')
  expect(html).toContain('matches')
  expect(html).toContain('1.3s')
})

test('activity starts collapsed once answer text is visible', () => {
  const html = renderToStaticMarkup(
    <RunActivity steps={steps} hasAnswer runStatus="complete" />,
  )

  expect(html).toContain('<details')
  expect(html).not.toContain('open=""')
  expect(html).toContain('1 step')
})

test('hidden activity never leaks into the demo transcript', () => {
  const html = renderToStaticMarkup(
    <RunActivity
      steps={[
        ...steps,
        { ...steps[0], id: 'astep_hidden', title: 'Private', visibility: 'hidden' },
      ]}
      hasAnswer={false}
      runStatus="running"
    />,
  )

  expect(html).not.toContain('Private')
})
