import { expect, test } from 'bun:test'
import { createRoot, flush } from 'solid-js'

import { createTodoForm } from './form'

function mount() {
  const rejects: ((error: Error) => void)[] = []
  const submitted: string[] = []
  let form!: ReturnType<typeof createTodoForm>
  const dispose = createRoot((dispose) => {
    form = createTodoForm((title) => {
      submitted.push(title)
      return new Promise<void>((_, reject) => rejects.push(reject))
    })
    return dispose
  })
  return { form, rejects, submitted, dispose }
}

for (const nextDraft of ['second todo', '']) {
  test(
    'a failed add preserves newer edits: ' + JSON.stringify(nextDraft),
    async () => {
      const { form, rejects, dispose } = mount()
      try {
        form.setDraft('first todo')
        flush()
        const result = form.submit()
        flush()
        form.setDraft('second todo')
        form.setDraft(nextDraft)
        flush()
        rejects[0]!(new Error('create failed'))
        await result
        flush()
        expect(form.draft()).toBe(nextDraft)
        expect(form.failure()).toBe('create failed')
      } finally {
        dispose()
      }
    },
  )
}

test('an older failed add cannot restore its title after a newer submission', async () => {
  const { form, rejects, submitted, dispose } = mount()
  try {
    form.setDraft('first todo')
    flush()
    const first = form.submit()
    flush()
    form.setDraft('second todo')
    flush()
    const second = form.submit()
    flush()
    rejects[0]!(new Error('first failed'))
    await first
    flush()
    expect(form.draft()).toBe('')
    rejects[1]!(new Error('second failed'))
    await second
    flush()
    expect(form.draft()).toBe('second todo')
    expect(submitted).toEqual(['first todo', 'second todo'])
  } finally {
    dispose()
  }
})

test('a failed add restores its trimmed title when the draft is untouched', async () => {
  const { form, rejects, submitted, dispose } = mount()
  try {
    form.setDraft('  first todo  ')
    flush()
    const result = form.submit()
    flush()
    expect(form.draft()).toBe('')
    rejects[0]!(new Error('create failed'))
    await result
    flush()
    expect(form.draft()).toBe('first todo')
    expect(submitted).toEqual(['first todo'])
  } finally {
    dispose()
  }
})
