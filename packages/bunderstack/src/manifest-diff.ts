export type ManifestDifference = {
  kind: 'added' | 'removed' | 'changed'
  path: string
}

function visit(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: ManifestDifference[],
) {
  if (Object.is(expected, actual)) return
  if (expected === undefined) {
    differences.push({ kind: 'added', path })
    return
  }
  if (actual === undefined) {
    differences.push({ kind: 'removed', path })
    return
  }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  ) {
    differences.push({ kind: 'changed', path })
    return
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length)
    for (let index = 0; index < length; index++) {
      visit(expected[index], actual[index], `${path}[${index}]`, differences)
    }
    return
  }
  const expectedRecord = expected as Record<string, unknown>
  const actualRecord = actual as Record<string, unknown>
  const keys = new Set([
    ...Object.keys(expectedRecord),
    ...Object.keys(actualRecord),
  ])
  for (const key of [...keys].sort()) {
    visit(
      expectedRecord[key],
      actualRecord[key],
      path ? `${path}.${key}` : key,
      differences,
    )
  }
}

export function diffManifests(
  expected: unknown,
  actual: unknown,
): ManifestDifference[] {
  const differences: ManifestDifference[] = []
  visit(expected, actual, '', differences)
  return differences.sort(
    (a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind),
  )
}
