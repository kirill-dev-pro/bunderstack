// src/storage/s3.ts
import type {
  PresignGetOptions,
  PresignPutOptions,
  StorageAdapter,
} from './index'

interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  publicUrl?: string
}

export class S3StorageAdapter implements StorageAdapter {
  private client: InstanceType<typeof Bun.S3Client>
  private readonly publicUrl?: string

  constructor(cfg: S3Config) {
    this.client = new Bun.S3Client({
      bucket: cfg.bucket,
      region: cfg.region,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.endpoint && { endpoint: cfg.endpoint }),
    })
    this.publicUrl = cfg.publicUrl
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

  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return this.client.presign(key, {
      method: 'PUT',
      expiresIn: opts.expiresIn,
      ...(opts.contentType && { type: opts.contentType }),
    })
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    return this.client.presign(key, {
      method: 'GET',
      expiresIn: opts.expiresIn,
    })
  }

  async stat(
    key: string,
  ): Promise<{ size: number; contentType: string } | null> {
    try {
      const s = await this.client.stat(key)
      return { size: s.size, contentType: s.type }
    } catch {
      return null
    }
  }

  publicUrlFor(key: string): string | undefined {
    if (!this.publicUrl) return undefined
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.list({ prefix })
    return res.contents?.map((c) => c.key) ?? []
  }
}
