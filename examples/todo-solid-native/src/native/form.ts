import { createSignal } from 'solid-js'

/** Form state and mutation-scoped error presentation. */
export function createTodoForm(add: (title: string) => Promise<void>) {
  const [draft, writeDraft] = createSignal('')
  let revision = 0
  const setDraft = (value: string) => {
    revision++
    writeDraft(value)
  }
  const [failure, setFailure] = createSignal('')

  const run = async (mutation: Promise<void>, recover?: () => void) => {
    setFailure('')
    try {
      await mutation
    } catch (error) {
      recover?.()
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const submit = () => {
    const title = draft().trim()
    if (!title) return Promise.resolve()
    const submittedRevision = ++revision
    writeDraft('')
    return run(add(title), () => {
      if (revision === submittedRevision) writeDraft(title)
    })
  }

  return { draft, setDraft, failure, run, submit }
}
