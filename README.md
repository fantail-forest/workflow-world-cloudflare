# workflow-world-cloudflare

> [!WARNING]
> This project is currently in development and is not yet fully working.

Cloudflare Workers deployment target for the Workflow DevKit. Uses a two-worker architecture with Service Bindings to provide a clean, framework-agnostic DX.

| Workflow DevKit | Cloudflare Resource |
|---|---|
| Storage (per-run state) | Durable Object (SQLite) |
| Storage (global index) | D1 database |
| Queue (scheduling) | Cloudflare Queues |
| Streaming | Durable Object (SQLite) |
| World proxy | Service Binding (RPC) |

## Quick start

```ts
// src/worker.ts
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start, getRun } from "@workflow/core/runtime";
import { myWorkflow } from "#workflows";

export default withWorkflow({
  async fetch(request, env, ctx) {
    const run = await start(myWorkflow, [{ name: "Alice" }]);
    return Response.json({ runId: run.runId });
  },
});
```

## Packages

| Package | Description |
|---|---|
| [`workflow-world-cloudflare`](./packages/workflow-world-cloudflare) | Runtime library — `withWorkflow()`, proxy world, service entrypoint, builder, Durable Objects, queue consumer, inspect CLI |
| [`vite-plugin-workflow-cloudflare`](./packages/vite-plugin-workflow-cloudflare) | Vite plugin — SWC transform, HMR, production build via `CloudflareBuilder` |

## Repository layout

```
packages/
  workflow-world-cloudflare/         # Runtime, builder, CLI
  vite-plugin-workflow-cloudflare/   # Vite plugin
examples/
  user-onboarding-worker/            # Tutorial: Bare Worker + CLI
  user-onboarding-hono/              # Tutorial: Hono + Vite
docs/                                # VitePress documentation site
```

## Requirements

- Node.js >= 18
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

## Documentation

See [`docs/`](./docs/) or run the VitePress site locally:

```sh
cd docs
yarn dev
```
