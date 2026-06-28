import { test, expect, describe } from 'bun:test'

import { parseSize, resolveBuckets } from '../../src/storage/buckets.ts'

// ---------------------------------------------------------------------------
// parseSize
// ---------------------------------------------------------------------------

describe('parseSize', () => {
  test('number passes through as-is (bytes)', () => {
    expect(parseSize(0)).toBe(0)
    expect(parseSize(500)).toBe(500)
    expect(parseSize(1024)).toBe(1024)
  })

  test('bare number string treated as bytes', () => {
    expect(parseSize('500')).toBe(500)
    expect(parseSize('0')).toBe(0)
  })

  test('10kb → 10240', () => {
    expect(parseSize('10kb')).toBe(10 * 1024)
  })

  test('5mb → 5242880', () => {
    expect(parseSize('5mb')).toBe(5 * 1024 * 1024)
  })

  test('1gb → 1073741824', () => {
    expect(parseSize('1gb')).toBe(1 * 1024 * 1024 * 1024)
  })

  test('1.5mb floored to integer', () => {
    expect(parseSize('1.5mb')).toBe(Math.floor(1.5 * 1024 * 1024))
  })

  test('case-insensitive units', () => {
    expect(parseSize('10KB')).toBe(10 * 1024)
    expect(parseSize('5MB')).toBe(5 * 1024 * 1024)
    expect(parseSize('1GB')).toBe(1 * 1024 * 1024 * 1024)
    expect(parseSize('1B')).toBe(1)
  })

  test('surrounding whitespace allowed', () => {
    expect(parseSize(' 10kb ')).toBe(10 * 1024)
  })

  test('throws on invalid unit', () => {
    expect(() => parseSize('5tb')).toThrow('[bunderstack] invalid size "5tb"')
  })

  test('throws on garbage string', () => {
    expect(() => parseSize('abc')).toThrow('[bunderstack] invalid size "abc"')
  })

  test('throws on empty string', () => {
    expect(() => parseSize('')).toThrow('[bunderstack] invalid size ""')
  })

  test('throws on negative number', () => {
    expect(() => parseSize(-1)).toThrow()
  })

  test('throws on non-finite number', () => {
    expect(() => parseSize(Infinity)).toThrow()
    expect(() => parseSize(NaN)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — no input
// ---------------------------------------------------------------------------

describe('resolveBuckets — no input', () => {
  test('undefined input → single "default" bucket with local ./uploads backend', () => {
    const result = resolveBuckets(undefined)
    expect(result.defaultBucket).toBe('default')
    expect(result.buckets.size).toBe(1)
    const bucket = result.buckets.get('default')!
    expect(bucket).toBeDefined()
    expect(bucket.name).toBe('default')
    expect(bucket.backend).toEqual({ type: 'local', path: './uploads' })
    expect(bucket.visibility).toBe('private')
    expect(bucket.access.create).toBe('authenticated')
    expect(bucket.access.get).toBe('owner')
    expect(bucket.access.delete).toBe('owner')
    expect(bucket.transforms).toBe(false)
    expect(bucket.upload).toBeUndefined()
    expect(bucket.quota).toBeUndefined()
    expect(bucket.scope).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — shared local backend
// ---------------------------------------------------------------------------

describe('resolveBuckets — shared local backend', () => {
  test('local: "./up", no buckets → default bucket on that path', () => {
    const result = resolveBuckets({ local: './up' })
    const bucket = result.buckets.get('default')!
    expect(bucket.backend).toEqual({ type: 'local', path: './up' })
  })

  test('local: true → ./uploads path', () => {
    const result = resolveBuckets({ local: true })
    const bucket = result.buckets.get('default')!
    expect(bucket.backend).toEqual({ type: 'local', path: './uploads' })
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — shared s3 backend via env
// ---------------------------------------------------------------------------

describe('resolveBuckets — shared s3 backend via env', () => {
  const fakeEnv = {
    S3_BUCKET: 'my-bucket',
    S3_REGION: 'eu-west-1',
    S3_ACCESS_KEY_ID: 'AKID',
    S3_SECRET_ACCESS_KEY: 'SECRET',
    S3_ENDPOINT: 'https://s3.example.com',
  }

  test('s3: true + fake env → backend fields resolved from env', () => {
    const result = resolveBuckets({ s3: true }, fakeEnv)
    const bucket = result.buckets.get('default')!
    expect(bucket.backend).toEqual({
      type: 's3',
      bucket: 'my-bucket',
      region: 'eu-west-1',
      endpoint: 'https://s3.example.com',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
    })
  })

  test('s3 object with endpoint overrides env endpoint', () => {
    const result = resolveBuckets({ s3: { endpoint: 'https://custom.io' } }, fakeEnv)
    const bucket = result.buckets.get('default')!
    expect((bucket.backend as { endpoint?: string }).endpoint).toBe('https://custom.io')
  })

  test('missing env vars → empty strings for credentials', () => {
    const result = resolveBuckets({ s3: true }, {})
    const bucket = result.buckets.get('default')!
    const b = bucket.backend as { type: 's3'; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
    expect(b.bucket).toBe('')
    expect(b.region).toBe('us-east-1')
    expect(b.accessKeyId).toBe('')
    expect(b.secretAccessKey).toBe('')
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — two declared buckets
// ---------------------------------------------------------------------------

describe('resolveBuckets — two declared buckets', () => {
  const fakeEnv = {
    S3_BUCKET: 'shared',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY_ID: 'AK',
    S3_SECRET_ACCESS_KEY: 'SK',
  }

  const scopeFn = () => ({ orgId: 'x' })

  const input = {
    s3: true as const,
    defaultBucket: 'avatars',
    buckets: {
      avatars: {
        visibility: 'public' as const,
        upload: { maxSize: '5mb', accept: ['image/png', 'image/jpeg'] },
        transforms: true,
        scope: scopeFn,
        quota: { perUser: '100mb', perScope: '10gb' },
      },
      documents: {
        visibility: 'private' as const,
        upload: { maxSize: 1024 * 1024 },
        access: { get: 'authenticated' as const },
      },
    },
  }

  test('defaultBucket is "avatars"', () => {
    const result = resolveBuckets(input, fakeEnv)
    expect(result.defaultBucket).toBe('avatars')
  })

  test('avatars bucket — public visibility, access defaults for public', () => {
    const result = resolveBuckets(input, fakeEnv)
    const avatars = result.buckets.get('avatars')!
    expect(avatars.visibility).toBe('public')
    expect(avatars.access.create).toBe('authenticated')
    expect(avatars.access.get).toBe('public')
    expect(avatars.access.delete).toBe('owner')
  })

  test('avatars bucket — upload maxSize parsed, accept passed through', () => {
    const result = resolveBuckets(input, fakeEnv)
    const avatars = result.buckets.get('avatars')!
    expect(avatars.upload?.maxSizeBytes).toBe(5 * 1024 * 1024)
    expect(avatars.upload?.accept).toEqual(['image/png', 'image/jpeg'])
  })

  test('avatars bucket — transforms flag true', () => {
    const result = resolveBuckets(input, fakeEnv)
    expect(result.buckets.get('avatars')!.transforms).toBe(true)
  })

  test('avatars bucket — quota parsed', () => {
    const result = resolveBuckets(input, fakeEnv)
    const avatars = result.buckets.get('avatars')!
    expect(avatars.quota?.perUserBytes).toBe(100 * 1024 * 1024)
    expect(avatars.quota?.perScopeBytes).toBe(10 * 1024 * 1024 * 1024)
  })

  test('avatars bucket — scope passed through', () => {
    const result = resolveBuckets(input, fakeEnv)
    expect(result.buckets.get('avatars')!.scope).toBe(scopeFn)
  })

  test('documents bucket — private visibility, get defaults to owner', () => {
    const result = resolveBuckets(input, fakeEnv)
    const docs = result.buckets.get('documents')!
    expect(docs.visibility).toBe('private')
    expect(docs.access.create).toBe('authenticated')
    // explicit override: get:'authenticated'
    expect(docs.access.get).toBe('authenticated')
    expect(docs.access.delete).toBe('owner')
  })

  test('documents bucket — upload maxSize as number', () => {
    const result = resolveBuckets(input, fakeEnv)
    const docs = result.buckets.get('documents')!
    expect(docs.upload?.maxSizeBytes).toBe(1024 * 1024)
  })

  test('documents bucket — uses shared s3 backend', () => {
    const result = resolveBuckets(input, fakeEnv)
    const docs = result.buckets.get('documents')!
    expect(docs.backend).toMatchObject({ type: 's3', bucket: 'shared' })
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — physical-bucket escape hatch
// ---------------------------------------------------------------------------

describe('resolveBuckets — physical-bucket escape hatch', () => {
  const fakeEnv = {
    S3_BUCKET: 'shared',
    S3_REGION: 'us-west-2',
    S3_ACCESS_KEY_ID: 'AKID',
    S3_SECRET_ACCESS_KEY: 'SECRET',
  }

  test('bucket with own s3 block uses physical backend distinct from shared', () => {
    const result = resolveBuckets(
      {
        s3: true,
        defaultBucket: 'cdn',
        buckets: {
          cdn: {
            s3: { bucket: 'cdn-bucket', publicUrl: 'https://cdn.example.com' },
          },
        },
      },
      fakeEnv,
    )
    const cdn = result.buckets.get('cdn')!
    const b = cdn.backend as {
      type: 's3'
      bucket: string
      publicUrl?: string
      accessKeyId: string
      secretAccessKey: string
      region: string
    }
    expect(b.type).toBe('s3')
    expect(b.bucket).toBe('cdn-bucket')
    expect(b.publicUrl).toBe('https://cdn.example.com')
    // creds come from env, not the shared bucket name
    expect(b.accessKeyId).toBe('AKID')
    expect(b.secretAccessKey).toBe('SECRET')
    expect(b.region).toBe('us-west-2')
  })

  test('bucket with own local block uses physical local backend', () => {
    const result = resolveBuckets(
      {
        defaultBucket: 'media',
        buckets: {
          media: { local: '/var/media' },
        },
      },
      {},
    )
    expect(result.buckets.get('media')!.backend).toEqual({ type: 'local', path: '/var/media' })
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — defaultBucket validation
// ---------------------------------------------------------------------------

describe('resolveBuckets — defaultBucket validation', () => {
  test('defaultBucket pointing at non-declared bucket throws', () => {
    expect(() =>
      resolveBuckets({
        defaultBucket: 'missing',
        buckets: { images: {} },
      }),
    ).toThrow('[bunderstack] defaultBucket "missing" is not a declared bucket')
  })
})

// ---------------------------------------------------------------------------
// resolveBuckets — explicit access override
// ---------------------------------------------------------------------------

describe('resolveBuckets — explicit access override', () => {
  test('get: "authenticated" on private bucket overrides default "owner"', () => {
    const result = resolveBuckets({
      defaultBucket: 'files',
      buckets: {
        files: {
          visibility: 'private',
          access: { get: 'authenticated' },
        },
      },
    })
    const files = result.buckets.get('files')!
    expect(files.access.get).toBe('authenticated')
    // other defaults unaffected
    expect(files.access.create).toBe('authenticated')
    expect(files.access.delete).toBe('owner')
  })

  test('create override on public bucket', () => {
    const result = resolveBuckets({
      defaultBucket: 'public-files',
      buckets: {
        'public-files': {
          visibility: 'public',
          access: { create: 'public' },
        },
      },
    })
    const b = result.buckets.get('public-files')!
    expect(b.access.create).toBe('public')
    expect(b.access.get).toBe('public')
    expect(b.access.delete).toBe('owner')
  })
})
