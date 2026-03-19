# workflow-world-cloudflare

Cloudflare Workers "world" implementation for the Workflow DevKit. Provides the runtime glue between Workflow DevKit abstractions and Cloudflare primitives (D1, Durable Objects, Queues).

## Installation

```sh
npm install workflow-world-cloudflare
```

Peer dependencies: `@workflow/errors`, `@workflow/world`

## Usage

### Build

Generate `dist/_worker.js` and `wrangler.toml`:

```sh
npx workflow-cloudflare build --name <app-name>
```

The build command:
1. Bundles workflow and step functions with esbuild, injecting polyfills for `node:vm`, `node:module`, and `@vercel/functions`
2. Aliases `cbor-x` to its no-eval variant
3. Deep-merges `wrangler.app.toml` (or `wrangler.app.jsonc`) onto a generated base config and writes `wrangler.toml`

Output format defaults to TOML; pass `--format jsonc` for JSONC.

### Worker entry point

The generated entry point calls:

```ts
import { createCloudflareWorld, createWorkerHandlers, processQueueBatch } from 'workflow-world-cloudflare'
import { WorkflowRunDO, WorkflowStreamDO } from 'workflow-world-cloudflare/durable-objects'

export { WorkflowRunDO, WorkflowStreamDO }

export default {
  async fetch(request, env, ctx) {
    const world = await createCloudflareWorld(env)
    const handlers = createWorkerHandlers(world, { ... })
    return handlers.fetch(request, env, ctx)
  },
  async queue(batch, env, ctx) {
    const world = await createCloudflareWorld(env)
    return processQueueBatch(batch, world)
  },
}
```

`createCloudflareWorld` runs D1 schema migrations (idempotent) on every cold start.

### Accessing Cloudflare bindings from step functions

```ts
import { getCloudflareEnv } from 'workflow-world-cloudflare'

// Inside a step function only — throws if called from workflow scope or module scope
const env = getCloudflareEnv<Env>()
const result = await env.MY_KV.get('key')
```

`getCloudflareEnv()` reads from an `AsyncLocalStorage` populated by the entry point. It is only available inside step functions.

### Inspect CLI

```sh
npx workflow-cloudflare inspect runs
npx workflow-cloudflare inspect run <id>
npx workflow-cloudflare inspect steps
npx workflow-cloudflare inspect step <id>
npx workflow-cloudflare inspect events
npx workflow-cloudflare inspect hooks
npx workflow-cloudflare inspect streams
npx workflow-cloudflare inspect storage <runId>
```

Requires `WORKFLOW_INSPECT_TOKEN` set as a wrangler secret.

## Architecture

### Durable Objects

**`WorkflowRunDO`** — One instance per workflow run. Stores run metadata, step results, event log (append-only), hook registrations, and wait conditions in SQLite. Single-threaded, so no locking is required.

**`WorkflowStreamDO`** — One instance per stream. Stores chunks in SQLite and uses WebSocket signaling for real-time delivery.

### D1

Global index across all runs. Holds denormalized metadata, steps, hooks, and stream references. Updated asynchronously via `waitUntil` (eventually consistent). Single-run lookups go through `WorkflowRunDO` for strong consistency.

### Queue scheduling

Two queues: `<name>-workflow-runs` and `<name>-workflow-steps`. Delays longer than 24 hours are handled by chaining re-enqueues with capped 24-hour delays until the target time is reached.

### Polyfills

| Module | Behavior |
|---|---|
| `node:vm` | `runInContext()` resolves pre-imported workflow functions from `globalThis.__workflow_cloudflare_functions`; temporarily overrides `globalThis` properties (`Math`, `Date`, `crypto`, `fetch`) with deterministic SDK values |
| `node:module` | No-op `createRequire`; world is injected via `setWorld()` |
| `@vercel/functions` | Stores Cloudflare `ExecutionContext` in `AsyncLocalStorage`; delegates `waitUntil` to `ctx.waitUntil()` |

`cbor-x` is aliased to its `no-eval` variant to avoid `new Function()`.

## Required Cloudflare bindings

| Binding | Type | Purpose |
|---|---|---|
| `WORKFLOW_DB` | D1 Database | Global run index |
| `RUN_DO` | Durable Object | Per-run state (`WorkflowRunDO`) |
| `STREAM_DO` | Durable Object | Real-time streams (`WorkflowStreamDO`) |
| `WORKFLOW_QUEUE` | Queue Producer | Workflow scheduling |
| `WORKFLOW_STEP_QUEUE` | Queue Producer | Step scheduling |

These names are constants — renaming them breaks the runtime.

## Configuration

The build command produces a `wrangler.toml` derived by deep-merging:

1. Generated base config (Worker name, D1, queue, DO bindings, compatibility settings)
2. `wrangler.app.toml` or `wrangler.app.jsonc` (user overrides, version-controlled)

Merge rules: scalars — user wins; arrays — concatenated; `compatibility_flags` — set union; objects — recursive.

Add custom bindings (KV, R2, Hyperdrive, env vars, etc.) in `wrangler.app.toml`. Access them via `getCloudflareEnv()` inside step functions.

## Resource limits

| Resource | Limit |
|---|---|
| Queue message | 128 KB |
| Worker CPU time | 30 s per request (IO wait not counted) |
| D1 storage | 10 GB (Workers Paid) |
| Durable Object storage | 10 GB per instance (not auto-purged) |
| DO requests | ~1,000 req/s per instance |

Durable Object SQLite storage persists until explicitly deleted and continues to incur billing.
