import '@orpc/openapi/extensions/route'
import * as v from 'valibot'

import type {
  StorageExecutionContext,
  StorageOperations,
} from '../storage/operations'
import type { BucketStorageRegistry } from '../storage/registry'
import type { ApiContext } from './context'

import { createApiBuilder } from './builder'

const uploadResultSchema = v.strictObject({
  fileId: v.string(),
  url: v.string(),
})

const prepareUploadSchema = v.variant('mode', [
  v.strictObject({
    mode: v.literal('proxy'),
    uploadUrl: v.string(),
  }),
  v.strictObject({
    mode: v.literal('presign'),
    fileId: v.string(),
    uploadUrl: v.string(),
    method: v.literal('PUT'),
    confirmUrl: v.string(),
  }),
])

const responseHeadersSchema = v.record(
  v.string(),
  v.union([v.string(), v.array(v.string()), v.undefined()]),
)

async function executionContext(
  context: ApiContext<Record<string, unknown>, Record<string, unknown>>,
): Promise<StorageExecutionContext> {
  const session = await context.getSession()
  return {
    request: context.request,
    user: session.user,
    session: { activeOrganizationId: session.activeOrganizationId },
  }
}

function headersRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function buildBucketProcedures(
  name: string,
  operations: StorageOperations,
  builder: ReturnType<
    typeof createApiBuilder<Record<string, unknown>, Record<string, unknown>>
  >,
) {
  const prepareUpload = builder.public
    .route({
      method: 'POST',
      path: `/api/files/${name}/presign`,
      summary: `Prepare upload to ${name}`,
      tags: ['files'],
    })
    .input(
      v.strictObject({
        filename: v.optional(v.string()),
        contentType: v.optional(v.string()),
      }),
    )
    .output(prepareUploadSchema)
    .handler(({ input, context }) =>
      executionContext(context).then((exec) =>
        operations.prepareUpload(name, input, exec),
      ),
    )

  const upload = builder.public
    .route({
      method: 'POST',
      path: `/api/files/${name}`,
      summary: `Upload to ${name}`,
      tags: ['files'],
      inputStructure: 'detailed',
      outputStructure: 'detailed',
      requestBodyHint: 'form-data',
    })
    .input(
      v.strictObject({
        params: v.optional(v.strictObject({}), {}),
        query: v.optional(v.record(v.string(), v.unknown()), {}),
        headers: v.optional(v.record(v.string(), v.unknown()), {}),
        body: v.strictObject({ file: v.file() }),
      }),
    )
    .output(
      v.strictObject({
        status: v.literal(201),
        body: uploadResultSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      const result = await operations.upload(
        name,
        input.body.file,
        await executionContext(context),
      )
      return {
        status: result.status,
        body: { fileId: result.fileId, url: result.url },
      }
    })

  const confirmUpload = builder.public
    .route({
      method: 'POST',
      path: `/api/files/${name}/{id}/confirm`,
      summary: `Confirm upload to ${name}`,
      tags: ['files'],
    })
    .input(v.strictObject({ id: v.string() }))
    .output(uploadResultSchema)
    .handler(({ input, context }) =>
      executionContext(context).then((exec) =>
        operations.confirmUpload(name, input.id, exec),
      ),
    )

  const download = builder.public
    .route({
      method: 'GET',
      path: `/api/files/${name}/{+path}`,
      summary: `Download from ${name}`,
      tags: ['files'],
      inputStructure: 'detailed',
      outputStructure: 'detailed',
    })
    .input(
      v.strictObject({
        params: v.strictObject({ path: v.string() }),
        query: v.optional(v.record(v.string(), v.string()), {}),
        headers: v.optional(v.record(v.string(), v.unknown()), {}),
        body: v.optional(v.undefined()),
      }),
    )
    .output(
      v.union([
        v.strictObject({
          status: v.literal(200),
          headers: responseHeadersSchema,
          body: v.unknown(),
        }),
        v.strictObject({
          status: v.literal(302),
          headers: responseHeadersSchema,
          body: v.optional(v.undefined()),
        }),
      ]),
    )
    .handler(async ({ input, context }) => {
      const result = await operations.download(
        name,
        input.params.path,
        input.query,
        await executionContext(context),
      )
      if (result.kind === 'redirect') {
        return {
          status: 302 as const,
          headers: { Location: result.url },
          body: undefined,
        }
      }
      return {
        status: 200 as const,
        headers: headersRecord(result.headers),
        body: result.body,
      }
    })

  const deleteFile = builder.public
    .route({
      method: 'DELETE',
      path: `/api/files/${name}/{+path}`,
      summary: `Delete from ${name}`,
      tags: ['files'],
      successStatus: 204,
    })
    .input(v.strictObject({ path: v.string() }))
    .output(v.undefined())
    .handler(async ({ input, context }) => {
      await operations.delete(name, input.path, await executionContext(context))
      return undefined
    })

  return { prepareUpload, upload, confirmUpload, download, delete: deleteFile }
}

export function buildStorageApiRouter(
  registry: BucketStorageRegistry,
  operations: StorageOperations,
) {
  const builder = createApiBuilder<
    Record<string, unknown>,
    Record<string, unknown>
  >()
  return {
    files: Object.fromEntries(
      [...registry.keys()].map((name) => [
        name,
        buildBucketProcedures(name, operations, builder),
      ]),
    ),
  }
}
