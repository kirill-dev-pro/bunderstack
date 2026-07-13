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

## License

MIT
