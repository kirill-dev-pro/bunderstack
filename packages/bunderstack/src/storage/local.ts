// src/storage/local.ts
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export class LocalStorageAdapter {
  private readonly basePath: string
  constructor(basePath: string) {
    this.basePath = basePath
  }

  private filePath(fileId: string) {
    return join(this.basePath, fileId)
  }

  async upload(
    fileId: string,
    data: Blob | ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    await mkdir(this.basePath, { recursive: true })
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await Bun.write(
      Bun.file(this.filePath(fileId), { type: contentType }),
      bytes,
    )
  }

  async get(fileId: string): Promise<Response> {
    const file = Bun.file(this.filePath(fileId))
    if (!(await file.exists()))
      return new Response('Not found', { status: 404 })
    return new Response(file, {
      headers: {
        'Content-Type': file.type,
        'Cache-Control': 'public, max-age=31536000',
      },
    })
  }

  async delete(fileId: string): Promise<void> {
    const file = Bun.file(this.filePath(fileId))
    if (await file.exists()) await file.unlink()
  }

  async exists(fileId: string): Promise<boolean> {
    return Bun.file(this.filePath(fileId)).exists()
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    const file = Bun.file(this.filePath(key))
    if (!(await file.exists())) return null
    return { size: file.size, contentType: file.type }
  }

  async list(prefix: string): Promise<string[]> {
    const cleanPrefix = prefix.replace(/\/$/, '')
    const dir = join(this.basePath, cleanPrefix)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      // Missing dir (or prefix isn't a directory) → no derivatives.
      return []
    }
    return entries.map((name) => `${cleanPrefix}/${name}`)
  }
}
