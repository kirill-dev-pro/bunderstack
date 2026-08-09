export interface MergeOpenAPISpecsOptions {
  nativeSpec: Record<string, any>
  authSpec?: Record<string, any>
}

export function mergeOpenAPISpecs(
  options: MergeOpenAPISpecsOptions,
): Record<string, any> {
  const { nativeSpec, authSpec } = options

  const merged: Record<string, any> = {
    openapi: nativeSpec.openapi || authSpec?.openapi || '3.1.0',
    info: {
      title: 'Bunderstack API',
      version: '1.0.0',
      ...(nativeSpec.info || {}),
    },
    paths: { ...(nativeSpec.paths || {}) },
    components: {},
    security: [...(nativeSpec.security || [])],
    tags: [...(nativeSpec.tags || [])],
  }

  if (authSpec) {
    // 1. Rewrite auth paths
    if (authSpec.paths && typeof authSpec.paths === 'object') {
      for (const [rawPath, pathItem] of Object.entries(authSpec.paths)) {
        let targetPath = rawPath
        if (!targetPath.startsWith('/api/auth')) {
          targetPath = '/api/auth' + (targetPath.startsWith('/') ? targetPath : '/' + targetPath)
        }
        merged.paths[targetPath] = pathItem
      }
    }

    // 2. Merge security metadata
    if (Array.isArray(authSpec.security)) {
      for (const sec of authSpec.security) {
        if (
          !merged.security.some(
            (s: any) => JSON.stringify(s) === JSON.stringify(sec),
          )
        ) {
          merged.security.push(sec)
        }
      }
    }

    // 3. Merge tags
    if (Array.isArray(authSpec.tags)) {
      for (const tag of authSpec.tags) {
        if (!merged.tags.some((t: any) => t.name === tag.name)) {
          merged.tags.push(tag)
        }
      }
    }
  }

  // Merge components by category
  const categories = new Set([
    ...Object.keys(nativeSpec.components || {}),
    ...Object.keys(authSpec?.components || {}),
  ])

  for (const category of categories) {
    const nativeCat = nativeSpec.components?.[category] || {}
    const authCat = authSpec?.components?.[category] || {}

    const mergedCat: Record<string, any> = { ...nativeCat }

    for (const [key, authVal] of Object.entries(authCat)) {
      if (key in nativeCat) {
        const nativeVal = nativeCat[key]
        if (JSON.stringify(nativeVal) !== JSON.stringify(authVal)) {
          throw new Error(
            `[bunderstack] OpenAPI component collision: category "${category}" component "${key}"`,
          )
        }
      } else {
        mergedCat[key] = authVal
      }
    }

    merged.components[category] = mergedCat
  }

  return merged
}
