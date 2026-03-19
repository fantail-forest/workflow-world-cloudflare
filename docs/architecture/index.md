# Architecture

This page explains how Workflow DevKit concepts map to Cloudflare resources and why each mapping was chosen.

## Resource mapping

```
Workflow DevKit                    Cloudflare
-----------                    ----------
Storage (per-run state)   -->  Durable Object (RunDO) with SQLite
Storage (global index)    -->  D1 database
Queue (scheduling)        -->  Cloudflare Queues
Streaming                 -->  Durable Object (StreamDO) with SQLite
Polyfills                 -->  Build-time module aliasing (esbuild)
```

## Storage: D1 + Durable Objects

The storage layer uses two complementary systems:

### RunDO (per-run state)

Each workflow run gets its own Durable Object instance (`WorkflowRunDO`). The DO's internal SQLite database stores:

- Run metadata (status, workflow name, input/output, timestamps)
- Event log (append-only event sourcing)
- Step results
- Hook registrations
- Wait conditions

The single-threaded nature of a Durable Object guarantees that all event processing for a given run is serialized - no external transactions or locking needed. This is equivalent to the row-level locking strategy used by the Vercel world's Postgres backend.

### D1 (global index)

A D1 database provides the global index across all runs. It stores denormalized copies of run metadata, steps, hooks, and stream references. This enables cross-run queries like "list all running workflows" or "find runs by workflow name."

The D1 index is updated asynchronously from the RunDO via `waitUntil`, so it is eventually consistent. Single-run lookups always go through the RunDO for strong consistency.

### Why not just D1?

D1 alone cannot provide the per-run transactional guarantees needed for event sourcing. D1 has no row-level locking, and concurrent writes to the same run could produce inconsistent state. The RunDO's single-threaded execution model solves this naturally.

### Why not just Durable Objects?

Durable Objects have no cross-instance query capability. You cannot ask "give me all DOs where status = running." D1 fills this role as a queryable index.

## Scheduling: Cloudflare Queues

All workflow and step invocations flow through Cloudflare Queues. Two queues are used:

- `workflow-runs` - workflow function invocations
- `workflow-steps` - step function invocations

### Delay chaining for long sleeps

Cloudflare Queues support a maximum delay of 24 hours (`delaySeconds` capped at 86,400). For sleeps longer than 24 hours, the queue consumer re-enqueues the message with a capped delay, effectively chaining delays until the target time is reached:

```
sleep(72 hours)
  --> enqueue with delay 24h
  --> consumer wakes, checks resumeAt, re-enqueues with delay 24h
  --> consumer wakes, checks resumeAt, re-enqueues with delay 24h
  --> consumer wakes, resumeAt reached, execute
```

This is transparent to user code. `sleep()` accepts any duration and the infrastructure handles the chaining.

## Streaming: StreamDO

Each stream gets its own Durable Object instance (`WorkflowStreamDO`). The DO stores stream chunks in its internal SQLite and provides real-time notification to readers via WebSocket-like signaling.

Stream metadata is indexed in D1 for discoverability.

## Polyfill approach

The Workflow DevKit core uses several Node.js and Vercel-specific APIs that are not available on Cloudflare Workers. Rather than patching the core, build-time module aliasing replaces these modules with compatible polyfills:

| Module | Polyfill Strategy |
|---|---|
| `node:vm` | No-eval polyfill that looks up pre-imported workflow functions from a global map |
| `node:module` | No-op `createRequire` (world is injected via `setWorld()`, not `require()`) |
| `@vercel/functions` | Delegates `waitUntil` to Cloudflare's `ExecutionContext` via `AsyncLocalStorage` |
| `cbor-x` | Aliased to `cbor-x/dist/index-no-eval.cjs` (avoids `new Function()`) |

This approach requires zero modifications to `@workflow/core`. See [Security](/security) for details on the polyfill trust model.

## Worker entry point

The builder generates a `_worker.js` entry point that wires everything together:

1. Pre-imports workflow functions statically and registers them on `globalThis.__workflow_cloudflare_functions`
2. Creates the Cloudflare world from `env` bindings via `createCloudflareWorld(env)`
3. Routes HTTP requests to the appropriate DevKit handler (flow, step, webhook, manifest)
4. Processes queue batches via `processQueueBatch()`
5. Exports Durable Object classes (`WorkflowRunDO`, `WorkflowStreamDO`)

The entry point is fully auto-generated on every build. You should not edit it directly.
