# Multi-bucket storage design

Date: 2026-06-28
Status: Approved design, pre-implementation
Scope: `packages/bunderstack` core storage layer. Example apps
(`kanban-tanstack`, `standalone`, `nextjs`, `tanstack-start`) use the old
`storageOptions` + flat `/api/files/:id` API and will break; their migration is
**deferred to a follow-up branch** (root `bun test` only covers the package).
`storage: { local: './uploads' }` still parses (→ implicit `default` bucket).

## Goal

Replace the single-bucket file storage with **multiple named buckets**, each
carrying its own backend resolution, access rules, upload rules, visibility,
scope, and quota — all from one declarative `storage` config. The developer
keeps a single config object and gets the file-handling "goodies" (presigned
direct upload, CDN-direct public serving, scoped/workspace files, quotas,
orphan cleanup) out of the box.

The library is **not released**, so there is **no back-compat requirement** —
we take the clean break wherever it simplifies the design.

## Guiding principles

- **Do it the right way** unless it hurts performance or DX. Multi-bucket does
  not hurt DX: it stays a single declarative config.
- **Visibility is bucket-level, never object-level.** We never rely on
  per-object S3 ACLs — they are non-portable (Tigris is bucket-level only) and
  AWS now discourages them (Block Public Access + "bucket owner enforced"
  disables object ACLs by default).
- **Unify file access onto the existing access model** (`OperationRule` /
  `AccessContext` / `scope` from `access.ts`). No parallel, weaker access logic.
- **Internal tables live in Drizzle space** — provisioned like any other table,
  no hand-rolled runtime DDL.

---

## 1. Declarative config

One `storage` block: a shared backend at the top, named buckets below. Each
bucket overrides only what it needs.

```ts
createBunderstack({
  schema,
  storage: {
    s3: true,                 // shared backend (or `local: true` for dev)
    defaultBucket: 'default',

    buckets: {
      avatars: {
        visibility: 'public',                 // proxied w/ immutable cache by default
        access: { create: 'authenticated', delete: 'owner' },
        upload: { maxSize: '5mb', accept: ['image/*'] },
        transforms: true,                     // image resize/format allowed
      },

      documents: {
        visibility: 'private',                // presigned GET, access-checked
        access: {
          create: 'authenticated',
          get: (ctx) => ctx.user?.role === 'admin' || ctx.isOwner,
          delete: 'owner',
        },
        scope: (ctx) => ({ organizationId: ctx.session.activeOrganizationId }),
        upload: { maxSize: '100mb', accept: ['application/pdf', 'image/*'] },
        quota: { perUser: '1gb', perScope: '50gb' },
      },

      // Escape hatch: physical public bucket + CDN (model C, below)
      'public-assets': {
        visibility: 'public',
        s3: { bucket: 'my-app-cdn', publicUrl: 'https://cdn.myapp.com' },
      },
    },
  },
})
```

- **No buckets declared** → one implicit bucket named `default`
  (`visibility: 'private'`, default access). Getting started stays a one-liner.
- Each bucket's `access` reuses the real `OperationRule` (strings *or*
  functions); `scope` reuses the org model.
- `upload`, `transforms`, `quota` are per-bucket and optional.
- A bucket only needs its own `s3`/`local` block for the physical-bucket escape
  hatch; otherwise it's a logical prefix on the shared backend.

## 2. What a bucket *is*, physically (model C — hybrid)

A bucket is a **prefix on the shared backend by default**, and becomes a
**physical bucket** when given its own `{ s3: {...} }` block.

- Logical (default): key is `<bucket>/<uuid><ext>` on the shared backend. One
  set of credentials. Works identically on local and S3.
- Physical (opt-in): maps to a real separate bucket (e.g. a public-read CDN
  bucket). Per-bucket credentials/region/`publicUrl`.

Locally, physical-vs-logical collapses to "just a prefix" — clean dev story.

### Visibility resolution

`public` is a spectrum; `private` is always presigned-or-proxied:

- **public, no physical bucket** → Bunderstack proxies reads with
  `Cache-Control: public, max-age=31536000, immutable`. Portable to any backend.
- **public, with physical bucket** (`{ s3: { bucket, publicUrl } }`) → the whole
  physical bucket is public (set once by you/Terraform); GET returns a `302` to
  the direct CDN URL. No proxy.
- **private** → always access-checked, then presigned GET (`302`, ~60s TTL) on
  S3, or proxy stream on local. Never depends on ACLs.

## 3. Routing

Bucket is always in the path.

```
POST   /api/files/:bucket/presign      → mint presigned PUT, write `pending` meta
POST   /api/files/:bucket              → proxy upload (dev/local/tiny), writes `ready`
POST   /api/files/:bucket/:id/confirm  → flip `pending` → `ready`
GET    /api/files/:bucket/:id          → public→redirect/proxy; private→presigned GET
DELETE /api/files/:bucket/:id          → access-check, delete bytes + meta + transform cache
```

- Unknown `:bucket` → `404` with a clear `ErrorCode`.
- GET **redirects (302) rather than proxies whenever it can** — offloads
  bandwidth to S3/CDN. Presigned URLs are short-lived (~60s).
- `Content-Disposition` (original `filename` from metadata) is set on the
  **proxy path** only — public-shared and local. Presigned redirects can't carry
  it (see Bun presign limitation in §5); the app uses metadata `filename` for
  display.
- Transform query params (`?w=…&format=…`) are **rejected unless the bucket has
  `transforms: true`** — a private document bucket can't be coerced into running
  sharp.

## 4. Data model (single table, 1:1 logical=physical)

```sql
CREATE TABLE bunderstack_file_meta (
  file_id       TEXT PRIMARY KEY,   -- "<bucket>/<uuid><ext>" — opaque to clients
  bucket        TEXT NOT NULL,
  owner_id      TEXT,               -- nullable for public/anon uploads
  scope_json    TEXT,               -- {"organizationId":"org_..."} captured at create
  status        TEXT NOT NULL,      -- 'pending' | 'ready'
  filename      TEXT,               -- original name → Content-Disposition
  content_type  TEXT,
  size          INTEGER,            -- bytes; quota enforcement
  created_at    INTEGER NOT NULL,   -- epoch ms; orphan sweep
  confirmed_at  INTEGER             -- null until confirm/proxy-upload
);
CREATE INDEX bfm_owner ON bunderstack_file_meta (owner_id);
CREATE INDEX bfm_scope ON bunderstack_file_meta (bucket, scope_json);
CREATE INDEX bfm_sweep ON bunderstack_file_meta (status, created_at);
```

- `status` + `created_at` drive the orphan sweep.
- `scope_json` captured at presign time → binds a private file to its org;
  read-time scope checks compare against the requester's active org.
- `size` enables quotas; for presigned uploads we reconcile real size at confirm
  via `HEAD`.
- `file_id` is **opaque** — clients never parse it. (Forward-compat invariant,
  see §8.)

### Internal tables in Drizzle space

Define both internal tables (`bunderstack_file_meta` and
`_bunderstack_idempotency`) as real Drizzle tables in `internal-tables.ts`, and
auto-register them into the resolved schema before provisioning.

```ts
export const INTERNAL_TABLES = { bunderstackFiles, bunderstackIdempotency }
export const INTERNAL_TABLE_NAMES = new Set([
  'bunderstack_file_meta', '_bunderstack_idempotency',
])
```

Benefits beyond consistency:

1. **Removes per-request DDL.** Today `idempotency.ts` runs
   `CREATE TABLE IF NOT EXISTS` on *every* idempotent request, and
   `file-metadata.ts` on every owner read/write. Provisioned tables remove that.
2. **Type-safe internal queries** — sweep, quota sums, scope checks become
   Drizzle queries instead of raw `$client.execute`.

Guardrails:

- Internal tables go in `INTERNAL_TABLE_NAMES` and are **excluded from
  auto-CRUD** the same way `AUTH_TABLE_NAMES` are.
- Merged into the schema after the user's tables; a user table named
  `bunderstack_file_meta` is rejected (reserved prefix).

## 5. Upload flow (model C, with B fallback)

`StorageAdapter` grows optional capabilities; everything keys off whether the
adapter can presign.

```ts
interface StorageAdapter {
  upload(key, data, contentType): Promise<void>
  get(key): Promise<Response>
  delete(key): Promise<void>
  exists(key): Promise<boolean>
  // New — optional. Present on S3, absent on local.
  presignPut?(key, opts): Promise<{ url: string; fields?: Record<string, string> }>
  presignGet?(key, opts): Promise<string>
  head?(key): Promise<{ size: number; contentType: string } | null>
}
```

**Auto-selection (the C decision — must carry a prominent comment in code):**

- S3-class backend exposes `presignPut` → client uploads **direct to object
  storage**. The proxy path does `await file.arrayBuffer()`, loading the whole
  file into app memory → OOM under concurrent large uploads + all bytes transit
  our server. Direct presigned PUT removes both.
- Local/dev backend can't presign → fall back to the **proxy path**, so
  `POST a file` works with zero setup.
- **Tradeoff:** the presigned path is two-phase (presign → client PUT →
  confirm), so an abandoned/crashed client leaves a `pending` row. The orphan
  sweep (§6) reaps these. If two-phase proves too fragile, the fallback is
  **model B** (presign-only, drop the proxy path). The dual path is deliberate —
  do not "simplify" it away.

**Presigned path:**

1. `POST /:bucket/presign` → access-check `create`, capture `scope_json`, write
   `pending` row, return `{ fileId, uploadUrl }`. The PUT presign pins
   `Content-Type` via Bun's `type` option.
2. Client PUTs straight to S3.
3. `POST /:bucket/:id/confirm` → `stat` the object, write real `size` /
   `content_type`, flip `pending` → `ready`. Size/type violation → delete +
   reject.

> **Bun presign limitation (carry as a code comment).** Bun's
> `S3Client.presign(key, { method, expiresIn, type, acl })` is a plain
> SigV4-signed URL: it can pin `Content-Type` on a PUT but has **no
> `content-length-range` / POST-policy**, so upload size cannot be enforced
> at presign time — it is enforced **only at `confirm`** via `stat`. Likewise
> there is no signed `response-content-disposition`, so presigned downloads
> surface the object key, not the original filename (we store `filename` in
> metadata for app-UI display; the proxy path still sets `Content-Disposition`
> properly). Both are accepted for now; a future swap of the S3 client could
> lift them. The `confirm`-time `stat` is therefore the authoritative size gate
> for the presigned path.

**Proxy path (local/tiny):** validate `maxSize`/`accept` against the actual
`File`, stream to storage, write `ready` directly. No confirm.

Both paths converge on the same metadata row and the same access checks.

## 6. Lifecycle

- **Orphan sweep** — periodic task deletes `pending` rows older than
  `pendingTtlMs` (default 30 min) and their storage objects. Single lazy
  `setInterval` with `unref()`; off in tests by default; exported for
  deterministic/cron invocation (mirrors realtime keepalive).
- **Transform-cache cleanup** — derivative keys stored under a predictable
  prefix (`<key>__transforms/…`) so delete removes the whole derivative set.
  Fixes today's permanent leak of `fileId__hash` cache entries.
- **Helper-only cascade** — `app.storage.delete(fileId)` removes bytes + meta +
  derivatives. **No** declarative `onDelete` link, **no** auto-CRUD hook (the
  link column is app-specific; hidden magic avoided).
- **Hard delete** by default.

### DEFERRED — logical/physical split (return later)

A blob/file split was designed and deferred. It would solve three real use
cases the single-table model does not:

- **Soft / shadow delete** — mark logical file deleted, keep bytes
  (`file.deletedAt` + per-bucket `retention` policy).
- **Transfer ownership/scope** — mutate `file.ownerId` / `scopeJson`, no byte
  movement.
- **Duplicate / share to many users or orgs** — by-reference (new file row, same
  blob, `refcount++`) so sharing to N users stores bytes once; or by-copy (S3
  `CopyObject`).

Shape: `bunderstackBlob { key, bucket, size, contentType, refcount, createdAt }`
+ `bunderstackFile { id, blobKey, ownerId, scopeJson, status, filename,
createdAt, confirmedAt, deletedAt }`. Deletion decrements `refcount`; bytes
removed only at 0; orphan sweep also reaps `refcount=0` blobs (self-heals crash
mid-decrement).

Deferred because refcount correctness is a real cost vs. current need. **Two
forward-compat invariants keep this addable without breaking the public API:**

1. `fileId` is opaque — clients never parse it.
2. All deletion goes through `app.storage.delete()`, never inline.

This comment block must live at the top of the storage metadata module too, so
the rationale travels with the code.

## 7. Quotas

Per-bucket, optional, opt-in:

```ts
documents: { quota: { perUser: '1gb', perScope: '50gb' } }
```

Enforced at presign/upload time via `SUM(size)` over `ready` files:

- `perUser` → `WHERE bucket=? AND owner_id=? AND status='ready'`
- `perScope` → `WHERE bucket=? AND scope_json=? AND status='ready'`

`current + maxSize > limit` → `413` before minting the presign (presigned
uploads report size only at confirm, so reserve worst-case `maxSize`, reconcile
at confirm). Indexes `bfm_owner` / `bfm_scope` keep the SUM cheap.

YAGNI: no soft-warnings, no per-file-type quotas, no global account quota.

## 8. Clean break + access unification

No back-compat (library unreleased):

- Bucket is **always** in the path: `/api/files/:bucket/:id`. No old flat route,
  no disambiguation.
- No `storageOptions: { uploadRules, access }` — that config moves into each
  bucket's `upload` / `access`.
- `storage: { s3: true }` still parses as "shared backend, zero buckets" → one
  implicit `default` bucket.

Access unification:

- Delete the weak parallel `checkFileAccess` in `file-metadata.ts`.
- File ops route through the real `checkAccess(rule, ctx, ownerColumn)` from
  `access.ts`, with `ctx` built from the file's metadata row
  (`row: fileMetaRow`, `session.activeOrganizationId`, `isOwner`).
- Files get **function rules** + **`scope`** for free — one access model across
  tables and files. `access: { get: 'owner' }` means the same thing on a bucket
  as on a table.

---

## Implementation surface (files touched)

- `config.ts` — `StorageConfigSchema` → buckets; `ResolvedStorage` → `ResolvedBucket[]`.
- `storage/index.ts` — `StorageAdapter` gains `presignPut`/`presignGet`/`head`;
  `createStorage` resolves per-bucket backends.
- `storage/s3.ts`, `storage/local.ts` — implement presign (S3) / proxy-only (local).
- `internal-tables.ts` (new) — Drizzle defs for file-meta + idempotency.
- `file-metadata.ts` — Drizzle queries; delete weak `checkFileAccess`; sweep/quota helpers.
- `idempotency.ts` — drop `ensureTable`, use provisioned Drizzle table.
- `index.ts` — `buildStorageRouter` becomes bucket-aware; wire access unification,
  sweep lifecycle, `app.storage.delete()` helper, schema auto-registration.
- `provision.ts` — include internal tables.
- Tests across `tests/storage/**` + new presign/scope/quota/sweep coverage.

## Test plan (TDD)

- Config resolution: shorthand, multi-bucket, physical escape hatch, default bucket.
- Routing: bucket in path, unknown bucket 404, transform guard.
- Visibility: public-proxy headers, public-physical 302, private presigned 302.
- Upload: presign conditions, confirm reconciliation, proxy path, constraint reject.
- Access: function rules + scope parity with table access.
- Lifecycle: orphan sweep, transform-cache cleanup on delete.
- Quotas: perUser/perScope enforcement at presign, 413.
- Internal tables: provisioned, excluded from CRUD, reserved-name rejection.
