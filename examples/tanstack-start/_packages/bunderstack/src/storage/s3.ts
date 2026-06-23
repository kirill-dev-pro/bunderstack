// src/storage/s3.ts
import type { StorageAdapter } from './index.ts'

interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}

export class S3StorageAdapter implements StorageAdapter {
  private client: InstanceType<typeof Bun.S3Client>

  constructor(cfg: S3Config) {
    this.client = new Bun.S3Client({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.endpoint && { endpoint: cfg.endpoint }),
    })
  }

  async upload(
    fileId: string,
    data: Blob | ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    await this.client.write(fileId, bytes, { type: contentType })
  }

  async get(fileId: string): Promise<Response> {
    const exists = await this.client.exists(fileId)
    if (!exists) return new Response('Not found', { status: 404 })
    const file = this.client.file(fileId)
    return new Response(file.stream(), {
      headers: { 'Content-Type': file.type ?? 'application/octet-stream' },
    })
  }

  async delete(fileId: string): Promise<void> {
    await this.client.delete(fileId)
  }

  async exists(fileId: string): Promise<boolean> {
    return this.client.exists(fileId)
  }
}
