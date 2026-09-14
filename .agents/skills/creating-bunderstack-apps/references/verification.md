# Verification contract

Run these gates from the application root after changing dependencies,
configuration, or application code:

```sh
bun install
bun test
bun run typecheck
bun run build
bun run blueprint
bun run blueprint:check
```

`bun run blueprint` generates the committed `bunderstack.blueprint.yaml` from
the configured Bunderstack entry. Set `package.json#bunderstack.entry` when the
entry is not `src/bunderstack.ts`. `bun run blueprint:check` must pass in CI so
the committed declaration matches the application.

Before production, generate and commit the Drizzle `migrations/` folder.
`provision(app)` from `bunderstack/provision` only applies committed
migrations and never imports drizzle-kit. For the local schema-push loop, import
`provision` from `bunderstack/provision-schema`; that development-only
entrypoint requires drizzle-kit. Keep the generated migrations, blueprint,
tests, worker entry, API mount, and deployment scripts under version control;
never commit secrets, databases, uploads, or build output.
