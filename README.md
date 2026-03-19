# workflow-world-cloudflare

Cloudflare Workers deployment target for the Workflow DevKit. Maps Workflow DevKit abstractions to Cloudflare primitives.

| Workflow DevKit | Cloudflare Resource |
|---|---|
| Storage (per-run state) | Durable Object (SQLite) |
| Storage (global index) | D1 database |
| Queue (scheduling) | Cloudflare Queues |
| Streaming | Durable Object (SQLite) |

## Packages

| Package | Description |
|---|---|
| [`workflow-world-cloudflare`](./packages/workflow-world-cloudflare) | Runtime library — Cloudflare Workers entry point, Durable Object classes, queue consumer, inspect CLI |
| [`vite-plugin-workflow-cloudflare`](./packages/vite-plugin-workflow-cloudflare) | Vite plugin — SWC transform, HMR, production build via `CloudflareBuilder` |

## Repository layout

```
packages/
  workflow-world-cloudflare/               # workflow-world-cloudflare
  vite-plugin-workflow-cloudflare/ # vite-plugin-workflow-cloudflare
docs/                             # VitePress documentation site
```

## Requirements

- Node.js ≥ 18
- Yarn 4 (Berry)
- Cloudflare account with Workers Paid plan (D1, Queues, Durable Objects)

## Development

```sh
yarn install
yarn build       # build all packages (Turbo)
yarn test        # run unit tests (Vitest)
yarn typecheck   # type-check all packages
yarn lint        # lint with Biome
```

End-to-end tests use `wrangler`'s `unstable_dev` API and require a Cloudflare-compatible environment (Miniflare).

## Documentation

See [`docs/`](./docs/) or run the VitePress site locally:

```sh
cd docs
yarn dev
```
