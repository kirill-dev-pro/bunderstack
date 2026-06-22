// src/storage/local.ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export class LocalStorageAdapter {
  constructor(private readonly basePath: string) {}

  private filePath(fileId: string) {
    return join(this.basePath, fileId)
  }

  async upload(fileId: string, data: Blob | ArrayBuffer, contentType: string): Promise<void> {
    await mkdir(this.basePath, { recursive: true })
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await Bun.write(
      Bun.file(this.filePath(fileId), { type: contentType }),
      bytes,
    )
  }

  async get(fileId: string): Promise<Response> {
    const file = Bun.file(this.filePath(fileId))
    if (!(await file.exists())) return new Response('Not found', { status: 404 })
    return new Response(file, {
      headers: { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=31536000' },
    })
  }

  async delete(fileId: string): Promise<void> {
    const file = Bun.file(this.filePath(fileId))
    if (await file.exists()) await file.unlink()
  }

  async exists(fileId: string): Promise<boolean> {
    return Bun.file(this.filePath(fileId)).exists()
  }
}
