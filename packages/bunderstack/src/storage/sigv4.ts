// src/storage/sigv4.ts — AWS Signature Version 4 on WebCrypto, so S3 access
// and presigned URLs work in Bun, workerd, and celld without Bun.S3Client.
export type SigV4Credentials = {
  accessKeyId: string
  secretAccessKey: string
  region: string
  service?: string
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

async function sha256Hex(
  data: ArrayBuffer | Uint8Array<ArrayBuffer> | string,
): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest('SHA-256', bytes))
}

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

async function signingKey(
  secret: string,
  day: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), day)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  return hmac(kService, 'aws4_request')
}

/** RFC 3986 encoding, as SigV4 requires: only A-Z a-z 0-9 - _ . ~ stay. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** S3 does not normalize paths: encode each segment once, keep the slashes. */
function canonicalPath(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join('/')
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

function amzDates(date: Date): { amzDate: string; day: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, day: amzDate.slice(0, 8) }
}

async function signature(
  credentials: SigV4Credentials,
  day: string,
  amzDate: string,
  canonicalRequest: string,
): Promise<{ scope: string; signature: string }> {
  const service = credentials.service ?? 's3'
  const scope = `${day}/${credentials.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')
  const key = await signingKey(
    credentials.secretAccessKey,
    day,
    credentials.region,
    service,
  )
  return { scope, signature: hex(await hmac(key, stringToSign)) }
}

export async function signRequest(input: {
  method: string
  url: string
  headers?: Record<string, string>
  body?: ArrayBuffer | Uint8Array<ArrayBuffer> | string | null
  credentials: SigV4Credentials
  date?: Date
  unsignedPayload?: boolean
}): Promise<Record<string, string>> {
  const url = new URL(input.url)
  const { amzDate, day } = amzDates(input.date ?? new Date())
  const payloadHash = input.unsignedPayload
    ? 'UNSIGNED-PAYLOAD'
    : await sha256Hex(input.body ?? '')
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers[k.toLowerCase()] = v.trim()
  }
  headers['host'] = url.host
  headers['x-amz-date'] = amzDate
  headers['x-amz-content-sha256'] = payloadHash
  const names = Object.keys(headers).sort()
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n')
  const signed = await signature(
    input.credentials,
    day,
    amzDate,
    canonicalRequest,
  )
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${signed.scope}, ` +
    `SignedHeaders=${names.join(';')}, Signature=${signed.signature}`
  return headers
}

export async function presignUrl(input: {
  method: string
  url: string
  credentials: SigV4Credentials
  expiresIn: number
  date?: Date
  signedHeaders?: Record<string, string>
}): Promise<string> {
  const url = new URL(input.url)
  const { amzDate, day } = amzDates(input.date ?? new Date())
  const service = input.credentials.service ?? 's3'
  const headers: Record<string, string> = { host: url.host }
  for (const [k, v] of Object.entries(input.signedHeaders ?? {})) {
    headers[k.toLowerCase()] = v.trim()
  }
  const names = Object.keys(headers).sort()
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  url.searchParams.set(
    'X-Amz-Credential',
    `${input.credentials.accessKeyId}/${day}/${input.credentials.region}/${service}/aws4_request`,
  )
  url.searchParams.set('X-Amz-Date', amzDate)
  url.searchParams.set('X-Amz-Expires', String(input.expiresIn))
  url.searchParams.set('X-Amz-SignedHeaders', names.join(';'))
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${headers[n]}\n`).join(''),
    names.join(';'),
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const signed = await signature(
    input.credentials,
    day,
    amzDate,
    canonicalRequest,
  )
  url.searchParams.set('X-Amz-Signature', signed.signature)
  return url.toString()
}
