# New-project code quality

Use the same defaults for standalone APIs, browser apps, and full SaaS apps.
Install development tooling in the app's Git root:

```sh
bun add -d uncheck@^0.1.1 oxlint@^1.71.0 oxfmt@^0.56.0 typescript@^5.8.0
```

Copy [the formatting config](oxfmtrc.json) to `.oxfmtrc.json` in the project
root. This is a project-owned copy, not a shared preset: the app can change it
freely. Oxlint uses its default rules; add `.oxlintrc.json` for custom rules.

Merge these scripts into `package.json`, preserving any existing scripts:

```json
{
  "scripts": {
    "check": "uncheck",
    "fix": "uncheck --fix",
    "prepare": "uncheck prepare --pre-commit --only=oxlint --only=oxfmt"
  }
}
```

If `prepare` already exists, chain the hook setup rather than replace it.
After `git init`, run `bun run prepare`; future development installs set up
the hook automatically. Each commit lints and formats staged files, stages
safe fixes, and blocks on remaining errors. Uncheck preserves partially
staged changes. Type checking is left to `bun run check` on the whole project.

Run `bun run check` in CI too, since local hooks can be skipped. For TanStack
Start, build first to generate the route tree required by type checking.
`bun run fix` applies lint and formatting fixes and reports type errors.
Production installs that omit devDependencies should disable lifecycle
scripts, since `prepare` needs the development tooling.
