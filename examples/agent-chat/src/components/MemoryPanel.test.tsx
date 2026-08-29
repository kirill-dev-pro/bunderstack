import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { MemoryPanel } from './MemoryPanel'

test('memory panel renders memory provenance and explicit edit/delete actions', () => {
  const html = renderToStaticMarkup(
    <MemoryPanel
      rows={[
        {
          id: 'amem_one',
          kind: 'preference',
          key: 'answer_style',
          value: 'Concise',
          sourceType: 'user',
        },
      ]}
      pending={false}
      onUpdate={() => {}}
      onDelete={() => {}}
    />,
  )

  expect(html).toContain('preference')
  expect(html).toContain('answer_style')
  expect(html).toContain('Concise')
  expect(html).toContain('From user')
  expect(html).toContain('aria-label="Edit answer_style"')
  expect(html).toContain('aria-label="Delete answer_style"')
})
