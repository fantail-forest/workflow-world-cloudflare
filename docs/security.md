# Security Model

The Cloudflare world implementation avoids `unsafe-eval` entirely. This page explains the polyfill approach, its trust boundaries, and how it compares to the Node.js execution model.

## No `unsafe-eval`

Cloudflare Workers reject `eval()`, `new Function()`, and `node:vm`'s `runInContext()` by default. Enabling the `unsafe-eval` compatibility flag weakens the V8 isolate's security guarantees.

This world implementation does not require `unsafe-eval`. Instead, it uses build-time module aliasing to replace unsupported modules with compatible polyfills.

## Polyfill details

### `node:vm` polyfill

The Workflow DevKit core uses `node:vm` to run workflow functions in a deterministic context (controlled `Math.random`, `Date.now`, `crypto`, etc.). On Workers, the `node:vm` import is aliased at build time to a polyfill that:

1. Handles `runInContext('globalThis', context)` by returning the context object directly
2. Handles `runInContext('<workflow code>; __private_workflows?.get("name")', context)` by:
   - Extracting the workflow name via regex
   - Looking up the pre-imported function from `globalThis.__workflow_cloudflare_functions`
   - Returning an async wrapper that temporarily overrides `globalThis` properties with the context's deterministic values

The key insight is that workflow functions are already known at build time. The `CloudflareBuilder` statically imports them and registers them on a global `Map`. The polyfill looks them up by name instead of evaluating code strings.

### Temporary global overrides

During workflow function execution, the polyfill temporarily replaces `globalThis` properties (`Math`, `Date`, `crypto`, `fetch`, etc.) with the deterministic versions from the devkit's context. The original values are saved and restored in a `finally` block.

This is safe because:

- Queue processing is sequential (one message at a time per Worker instance)
- The `finally` block runs even on `WorkflowSuspension` (the devkit's normal control flow mechanism)
- JavaScript resolves global names at call time, so the pre-imported function sees the overridden values

### `node:module` polyfill

The Workflow DevKit core calls `createRequire()` at module scope to support dynamic world loading. On Workers, this import is aliased to a no-op polyfill. The generated entry point calls `setWorld()` directly, so `createRequire` is never invoked at runtime.

### `@vercel/functions` polyfill

The Workflow DevKit core imports `waitUntil` from `@vercel/functions`. The polyfill stores the Cloudflare `ExecutionContext` in an `AsyncLocalStorage` and delegates to `ctx.waitUntil()`.

### `cbor-x` aliasing

The `cbor-x` serialization library uses `new Function()` internally for performance optimization. The builder aliases it to `cbor-x/dist/index-no-eval.cjs`, which avoids runtime code generation at the cost of slightly slower deserialization.

## Trust boundaries

The polyfill approach has different trust properties than Node.js `node:vm`:

| Property | Node.js `node:vm` | Cloudflare polyfill |
|---|---|---|
| Code isolation | Separate V8 context | Same context, temporary global overrides |
| Global leakage | Globals are isolated per context | Globals are shared, overridden temporarily |
| Concurrent safety | Safe (separate contexts) | Safe (sequential queue processing) |
| `unsafe-eval` required | No (Node.js native) | No (no eval at all) |

The Cloudflare polyfill does not provide the same level of isolation as `node:vm`. However, since both the workflow code and the polyfill are authored/built by the same developer, mutual trust is implicit. The polyfill's job is determinism (controlled randomness, time, etc.), not security isolation.

## `getCloudflareEnv()` scoping

The `getCloudflareEnv()` function only works inside step functions, which run with full runtime access. It throws if called from:

- Workflow functions (sandboxed, no I/O)
- Module scope (no request context)

This prevents accidental binding access from deterministic workflow code.

## Polyfill maintenance coupling

The `node:vm` polyfill relies on pattern-matching two specific `runInContext` call patterns from `@workflow/core`. If the core changes how it calls `runInContext`, the polyfill will need updating. This is a maintenance coupling, not a security concern.
