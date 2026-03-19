# workflow-world-cloudflare

Cloudflare Workers "world" implementation for the Workflow DevKit. Provides the runtime glue between Workflow DevKit abstractions and Cloudflare primitives (D1, Durable Objects, Queues) using a two-worker architecture with Service Bindings.

## Installation

```sh
npm install workflow-world-cloudflare
```

Peer dependencies: `@workflow/core`, `@workflow/errors`, `@workflow/world`

## Usage

### Integration with `withWorkflow()`

Wrap your Worker's default export with `withWorkflow()`:

```ts
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start, getRun } from "@workflow/core/runtime";
import { myWorkflow } from "#workflows";

export default withWorkflow({
  async fetch(request, env, ctx) {
    const run = await start(myWorkflow, [{ name: "Alice" }]);
    return Response.json({ runId: run.runId, status: await run.status });
  },
});
```

`withWorkflow()` accepts anything with a `.fetch()` method — raw Workers, Hono apps, Itty Router, etc.

### Build

Generate the two-worker output:

```sh
npx workflow-cloudflare build --name <app-name>
```

This produces:

```
dist/
  service-worker/          # Generated workflow service worker
    _worker.js             # Entry with DOs, queue handler, RPC entrypoint
    wrangler.toml          # Service worker config
  client.js                # Client library with .workflowId stubs
wrangler.toml              # User worker config (with Service Binding)
```

### Local development

```sh
npx workflow-cloudflare dev
```

Starts both workers locally with Service Bindings resolved by Miniflare.

### Accessing Cloudflare bindings from step functions

```ts
import { getCloudflareEnv } from 'workflow-world-cloudflare'

async function myStep() {
  "use step";
  const env = getCloudflareEnv<{ MY_KV: KVNamespace }>();
  return env.MY_KV.get('key');
}
```

### Inspect CLI

```sh
npx workflow-cloudflare inspect runs --url <url> --token <token>
npx workflow-cloudflare inspect run <id> --url <url> --token <token>
```

Requires `WORKFLOW_INSPECT_TOKEN` set as a wrangler secret.

## Architecture

### Two-worker model

- **User's Worker** — your code, wrapped with `withWorkflow()`. Communicates with the service worker via Service Binding RPC.
- **Workflow Service Worker** — generated, owns all infrastructure (D1, DOs, Queues). Exposes RPC via `WorkflowServiceEntrypoint`.

### Key components

- **`withWorkflow()`** — Sets up `CloudflareProxyWorld`, calls `setWorld()`, wraps fetch with `envStorage`
- **`CloudflareProxyWorld`** — Implements `World` interface by proxying through Service Binding RPC
- **`WorkflowServiceEntrypoint`** — `WorkerEntrypoint` subclass exposing typed RPC methods
- **`WorkflowRunDO`** — One Durable Object per run with SQLite event sourcing
- **`WorkflowStreamDO`** — One Durable Object per stream with chunk storage

### Service worker bindings

| Binding | Type | Purpose |
|---|---|---|
| `WORKFLOW_DB` | D1 Database | Global run index |
| `RUN_DO` | Durable Object | Per-run state |
| `STREAM_DO` | Durable Object | Real-time streams |
| `WORKFLOW_QUEUE` | Queue Producer | Workflow scheduling |
| `WORKFLOW_STEP_QUEUE` | Queue Producer | Step scheduling |

### User worker bindings

| Binding | Type | Purpose |
|---|---|---|
| `WORKFLOW` | Service Binding | Connection to service worker |

Plus any custom bindings from `wrangler.app.toml`.

### Security

- Flow/step handlers are internal to the service worker (not exposed as HTTP)
- Inspect and webhook endpoints are auth-gated (`WORKFLOW_INSPECT_TOKEN`)
- Manifest endpoint is disabled by default (opt-in via `WORKFLOW_PUBLIC_MANIFEST=1`)

## Configuration

The builder generates two `wrangler.toml` files:

1. **Service worker** (`dist/service-worker/wrangler.toml`) — all workflow bindings
2. **User worker** (`wrangler.toml`) — Service Binding + user overrides from `wrangler.app.toml`

Deep-merge rules: scalars — user wins; arrays — concatenated; objects — recursive.
