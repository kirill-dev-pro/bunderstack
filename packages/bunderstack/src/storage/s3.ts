// src/storage/s3.ts — S3 on fetch + SigV4, so the adapter runs outside Bun.
import type {
  PresignGetOptions,
  PresignPutOptions,
  StorageAdapter,
} from './index'

import { presignUrl, signRequest, type SigV4Credentials } from './sigv4'

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface S3Config {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  publicUrl?: string
  /** Injected in tests; defaults to the global fetch. */
  fetch?: Fetch
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export class S3StorageAdapter implements StorageAdapter {
  private readonly base: string
  private readonly credentials: SigV4Credentials
  private readonly publicUrl?: string
  private readonly fetchFn: Fetch

  constructor(cfg: S3Config) {
    const endpoint = (
      cfg.endpoint ?? `https://s3.${cfg.region}.amazonaws.com`
    ).replace(/\/$/, '')
    this.base = `${endpoint}/${cfg.bucket}`
    this.credentials = {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
    }
    this.publicUrl = cfg.publicUrl
    this.fetchFn = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  private objectUrl(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  private async send(
    method: string,
    url: string,
    body?: ArrayBuffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signed = await signRequest({
      method,
      url,
      headers,
      body: body ?? null,
      credentials: this.credentials,
    })
    return this.fetchFn(url, { method, headers: signed, body })
  }

  async upload(
    fileId: string,
    data: Blob | ArrayBuffer,
    contentType: string,
  ): Promise<void> {
    const bytes = data instanceof Blob ? await data.arrayBuffer() : data
    const res = await this.send('PUT', this.objectUrl(fileId), bytes, {
      'content-type': contentType,
    })
    if (!res.ok) {
      throw new Error(
        `[bunderstack] S3 upload failed (${res.status}): ${await res.text()}`,
      )
    }
  }

  async get(fileId: string): Promise<Response> {
    const res = await this.send('GET', this.objectUrl(fileId))
    if (res.status === 404) return new Response('Not found', { status: 404 })
    if (!res.ok) {
      throw new Error(`[bunderstack] S3 get failed (${res.status})`)
    }
    return new Response(res.body, {
      headers: {
        'Content-Type':
          res.headers.get('content-type') || 'application/octet-stream',
      },
    })
  }

  async delete(fileId: string): Promise<void> {
    const res = await this.send('DELETE', this.objectUrl(fileId))
    if (!res.ok && res.status !== 404) {
      throw new Error(`[bunderstack] S3 delete failed (${res.status})`)
    }
  }

  async exists(fileId: string): Promise<boolean> {
    return (await this.stat(fileId)) !== null
  }

  async stat(
    key: string,
  ): Promise<{ size: number; contentType: string } | null> {
    const res = await this.send('HEAD', this.objectUrl(key))
    if (!res.ok) return null
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? '',
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const url = new URL(this.base)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await this.send('GET', url.toString())
      if (!res.ok) {
        throw new Error(`[bunderstack] S3 list failed (${res.status})`)
      }
      const xml = await res.text()
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
        keys.push(decodeXml(match[1]!))
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? decodeXml(
            /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
              xml,
            )?.[1] ?? '',
          )
        : undefined
    } while (token)
    return keys
  }

  // The content type is not signed: confirmUpload checks the stored type.
  async presignPut(key: string, opts: PresignPutOptions): Promise<string> {
    return presignUrl({
      method: 'PUT',
      url: this.objectUrl(key),
      credentials: this.credentials,
      expiresIn: opts.expiresIn,
    })
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    return presignUrl({
      method: 'GET',
      url: this.objectUrl(key),
      credentials: this.credentials,
      expiresIn: opts.expiresIn,
    })
  }

  publicUrlFor(key: string): string | undefined {
    if (!this.publicUrl) return undefined
    return `${this.publicUrl.replace(/\/$/, '')}/${key}`
  }
}
