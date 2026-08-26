import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { SaveAgentPanel } from './SaveAgentPanel'

test('save panel renders labeled email and password fields', () => {
  const html = renderToStaticMarkup(
    <SaveAgentPanel userName="Gentle Otter" onSaved={() => {}} />,
  )

  expect(html).toContain('Save your agent')
  expect(html).toContain('for="save-agent-email"')
  expect(html).toContain('type="email"')
  expect(html).toContain('for="save-agent-password"')
  expect(html).toContain('type="password"')
})
