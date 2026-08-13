const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
])

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
    paths: JSON.parse(JSON.stringify(nativeSpec.paths || {})),
    components: {},
    security: [...(nativeSpec.security || [])],
    tags: [...(nativeSpec.tags || [])],
  }

  if (authSpec) {
    // Merge paths and check for overwrite collisions
    if (authSpec.paths && typeof authSpec.paths === 'object') {
      for (const [routePath, authPathItem] of Object.entries(authSpec.paths)) {
        if (!authPathItem || typeof authPathItem !== 'object') continue

        const clonedPathItem = JSON.parse(
          JSON.stringify(authPathItem),
        ) as Record<string, any>

        // Normalize tags for Better Auth operations (replace generic "Default" with "Auth")
        if (routePath.startsWith('/api/auth')) {
          for (const [methodKey, operation] of Object.entries(clonedPathItem)) {
            if (
              HTTP_METHODS.has(methodKey.toUpperCase()) &&
              operation &&
              typeof operation === 'object'
            ) {
              if (Array.isArray(operation.tags)) {
                operation.tags = operation.tags.map((t: string) =>
                  t === 'Default' ? 'Auth' : t,
                )
                if (!operation.tags.includes('Auth')) {
                  operation.tags.unshift('Auth')
                }
              } else {
                operation.tags = ['Auth']
              }
            }
          }
        }

        if (!(routePath in merged.paths)) {
          merged.paths[routePath] = clonedPathItem
        } else {
          const existingPathItem = merged.paths[routePath]
          const incomingPathItem = clonedPathItem

          for (const [key, authVal] of Object.entries(incomingPathItem)) {
            const upperKey = key.toUpperCase()
            const isOperation = HTTP_METHODS.has(upperKey)

            if (key in existingPathItem) {
              const existingVal = existingPathItem[key]
              if (JSON.stringify(existingVal) !== JSON.stringify(authVal)) {
                if (isOperation) {
                  throw new Error(
                    `[bunderstack] OpenAPI path overwrite collision: operation "${upperKey} ${routePath}"`,
                  )
                } else {
                  throw new Error(
                    `[bunderstack] OpenAPI path property collision on "${routePath}": key "${key}"`,
                  )
                }
              }
            } else {
              existingPathItem[key] = JSON.parse(JSON.stringify(authVal))
            }
          }
        }
      }
    }

    // Merge security metadata
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

    // Merge tags
    if (!merged.tags.some((t: any) => t.name === 'Auth')) {
      merged.tags.push({
        name: 'Auth',
        description: 'Authentication and session management',
      })
    }
    if (Array.isArray(authSpec.tags)) {
      for (const tag of authSpec.tags) {
        if (
          tag.name !== 'Default' &&
          !merged.tags.some((t: any) => t.name === tag.name)
        ) {
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

  // Ensure all tags used in path operations are declared in merged.tags
  for (const pathItem of Object.values(merged.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue
    for (const [key, op] of Object.entries(pathItem as Record<string, any>)) {
      if (
        HTTP_METHODS.has(key.toUpperCase()) &&
        op &&
        typeof op === 'object' &&
        Array.isArray(op.tags)
      ) {
        for (const tagName of op.tags) {
          if (
            tagName &&
            tagName !== 'Default' &&
            !merged.tags.some((t: any) => t.name === tagName)
          ) {
            merged.tags.push({
              name: tagName,
              description: `${tagName} operations`,
            })
          }
        }
      }
    }
  }

  return merged
}
