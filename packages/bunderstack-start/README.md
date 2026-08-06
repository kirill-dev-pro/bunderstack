# bunderstack-start

TanStack Start integration for
[bunderstack](https://github.com/kirill-dev-pro/bunderstack): isomorphic
fetch wiring, auth client, and query/sync setup for SSR apps.

```sh
bun add bunderstack-start
```

Full documentation and examples:
[github.com/kirill-dev-pro/bunderstack](https://github.com/kirill-dev-pro/bunderstack)

## Shipping TypeScript source

This package publishes raw TypeScript (`exports` point at `.ts` files). Bun
consumes it natively. If a Node-based bundler or SSR server processes it,
make sure the package is bundled rather than externalized — e.g. in Vite:

```ts
ssr: {
  noExternal: [/^bunderstack/]
}
```

Because `exports` point straight at source, your TypeScript and bundler
resolve modules *inside this package's own directory* rather than a compiled
`dist`. That makes a stray `node_modules/bunderstack-start/node_modules/`
uniquely dangerous: if one is ever present (e.g. left over from an earlier
`link:`/`file:` dependency on a local checkout, then never cleaned up after
switching to a registry version), both `tsc` and the bundler will resolve
peer packages like `@tanstack/react-start`, `better-auth`, or
`@tanstack/react-query` from inside it instead of your app's own
`node_modules`. Two copies of a context-carrying package means two separate
module instances at runtime — an auth session or query cache set up by one
copy becomes invisible to code importing the other. If you hit unexplained
"not found"/mismatched-type errors, check for nested `node_modules` under
this package's install location before assuming it's an application bug:

```sh
find node_modules -path '*/bunderstack-start/node_modules/@tanstack*'
```

A clean `rm -rf node_modules && bun install` removes any that a normal
install wouldn't have produced on its own.

## License

MIT
