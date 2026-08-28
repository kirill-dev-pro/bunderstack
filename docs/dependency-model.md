# Dependency model

Bunderstack keeps integration boundaries explicit. The root entrypoint needs
`better-auth`, `drizzle-orm`, Hono, and Zod, so those are required peer
dependencies. Drivers, Nodemailer, drizzle-kit, and TypeScript are optional
peers: install them only when the corresponding feature needs them.

TypeScript remains `>=5` even though it is optional. The package publishes
`.ts` source, so a tool that type-checks or compiles that source needs
TypeScript; Bun installations that already transpile it are not forced to add a
separate TypeScript dependency by the optional peer metadata.

## Database adapters

Choose one database adapter and import it from its public subpath. Its dialect
must match the Drizzle schema, and only its optional peer needs to be installed.

| Import                             | Factory        | Optional peer                 | Compatible schema      |
| ---------------------------------- | -------------- | ----------------------------- | ---------------------- |
| `bunderstack/libsql`      | `libsql()`     | `@libsql/client`              | SQLite (`sqliteTable`) |
| `bunderstack/pglite`      | `pglite()`     | `@electric-sql/pglite`        | Postgres (`pgTable`)   |
| `bunderstack/bun-sql`     | `bunSql()`     | none — Bun provides `Bun.sql` | Postgres (`pgTable`)   |
| `bunderstack/postgres-js` | `postgresJs()` | `postgres`                    | Postgres (`pgTable`)   |

For example, a SQLite application selects libSQL directly:

```ts
import { createBunderstack } from 'bunderstack'
import { libsql } from 'bunderstack/libsql'

const app = await createBunderstack({
  schema,
  database: {
    adapter: libsql(),
    url: 'file:./data.db',
  },
})
```

`BUNDERSTACK_INTROSPECT=1` does not connect to the selected database. Instead,
that adapter returns `drizzle.mock({ schema })`; this keeps manifest inspection
offline. A normal adapter connection returns its real client cleanup to the
app, so `await app.close()` closes real libSQL, PGlite, postgres.js, and Bun SQL
clients. Introspection mocks own no real client.

## Email

Resend and the console provider are available through the root configuration.
SMTP is deliberately isolated behind `bunderstack/email-smtp`; install the
optional `nodemailer` peer and pass `smtp({ url })` as `email.provider`.

```ts
import { smtp } from 'bunderstack/email-smtp'

const email = {
  from: 'My app <hello@example.com>',
  provider: smtp({ url: process.env.SMTP_URL! }),
}
```
