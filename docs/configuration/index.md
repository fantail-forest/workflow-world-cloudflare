# Configuration

The Cloudflare builder generates a `wrangler.toml` (or `wrangler.jsonc`) with all required bindings pre-configured. You control customizations through a separate override file that gets merged at build time.

## How it works

Every time you run `workflow-cloudflare build`, the builder generates two wrangler configs:

1. **Service worker config** (`dist/service-worker/wrangler.toml`) -- contains all workflow bindings (D1, Durable Objects, Queues, migrations)
2. **User worker config** (`wrangler.toml`) -- contains the Service Binding to the service worker, merged with your overrides

For the user worker config, the builder:

1. Generates a base config with the Service Binding and compatibility flags
2. Looks for a user override file (`wrangler.app.toml` or `wrangler.app.jsonc`)
3. Deep-merges the override on top of the base config
4. Writes the final config to `wrangler.toml` (or `wrangler.jsonc`)

The generated config file is builder-owned and should be gitignored. Your override file is version-controlled and contains only your customizations.

```
project/
  wrangler.app.toml    # Your customizations (version-controlled)
  wrangler.toml        # Generated output (gitignored)
```

Add to `.gitignore`:

```
wrangler.toml
wrangler.jsonc
```

## Resource namespacing

Cloudflare Queues and D1 databases are account-scoped resources -- their names must be unique across your entire Cloudflare account. If two projects use the same resource names, they'll share (and corrupt) each other's data.

The builder prevents this by namespacing all account-scoped resources under the **app name**:

```bash
npx workflow-cloudflare build --name billing
```

This produces configs with resource names derived from `billing`:

| Resource | Generated name |
|---|---|
| User worker | `billing` |
| Service worker | `billing-workflow` |
| D1 database | `billing-workflow-db` |
| Run queue | `billing-workflow-runs` |
| Step queue | `billing-workflow-steps` |

If `--name` is omitted, the builder defaults to the working directory name.

Durable Object classes (`WorkflowRunDO`, `WorkflowStreamDO`) are scoped to the Worker script that deploys them, so they do not collide across projects.

### Overriding resource names

If you need full control over resource names, override them in your `wrangler.app.toml`. Since scalars use "override wins" merge behavior, your values replace the builder's defaults:

```toml
name = "my-custom-worker-name"

[[d1_databases]]
binding = "WORKFLOW_DB"
database_name = "my-custom-db"

[[queues.producers]]
binding = "WORKFLOW_QUEUE"
queue = "my-custom-run-queue"

[[queues.producers]]
binding = "WORKFLOW_STEP_QUEUE"
queue = "my-custom-step-queue"

[[queues.consumers]]
queue = "my-custom-run-queue"

[[queues.consumers]]
queue = "my-custom-step-queue"
```

::: warning
The **binding names** (`WORKFLOW_DB`, `RUN_DO`, `STREAM_DO`, `WORKFLOW_QUEUE`, `WORKFLOW_STEP_QUEUE`) are constants used by the runtime and must not be renamed. Only the underlying resource names (database name, queue name) are safe to customize.
:::

## Merge behavior

The deep-merge follows these rules:

| Type | Behavior |
|---|---|
| Scalars (strings, numbers, booleans) | User override wins |
| Arrays | Concatenated (base + override) |
| `compatibility_flags` | Set union (no duplicates) |
| Objects | Recursively merged |

This means you can add bindings, routes, or other config without repeating the builder's defaults.

## Required bindings

### Service worker bindings (auto-generated)

The service worker's `wrangler.toml` contains:

| Binding | Type | Purpose |
|---|---|---|
| `WORKFLOW_DB` | D1 Database | Global index for runs, hooks, steps, streams |
| `RUN_DO` | Durable Object | Per-run state and event sourcing |
| `STREAM_DO` | Durable Object | Real-time stream delivery |
| `WORKFLOW_QUEUE` | Queue Producer | Workflow invocation scheduling |
| `WORKFLOW_STEP_QUEUE` | Queue Producer | Step invocation scheduling |

### User worker bindings (auto-generated)

Your worker's `wrangler.toml` contains:

| Binding | Type | Purpose |
|---|---|---|
| `WORKFLOW` | Service Binding | Connection to the workflow service worker |

Plus any custom bindings from your `wrangler.app.toml`.

## Runtime initialization

In your worker, `withWorkflow()` handles all initialization:

1. Creates a `CloudflareProxyWorld` from the `WORKFLOW` Service Binding
2. Calls `setWorld()` internally so `start()` and `getRun()` work
3. Wraps every request in `envStorage.run(env, ...)` for `getCloudflareEnv()`
4. Wraps every request in `executionContextStorage.run(ctx, ...)` for `waitUntil`

You do not need to write any initialization code yourself.

## Inspecting runs

The `workflow-cloudflare inspect` CLI lets you query workflow runs, steps, events, hooks, and streams from a deployed Worker.

### Setup

Inspect endpoints are disabled by default. To enable them, set a `WORKFLOW_INSPECT_TOKEN` secret on your Worker:

```bash
wrangler secret put WORKFLOW_INSPECT_TOKEN
```

The inspect endpoints are served at `/.well-known/workflow/v1/inspect/*` and require an `Authorization: Bearer <token>` header matching this secret.

### CLI usage

```bash
# List recent runs
npx workflow-cloudflare inspect runs --url https://my-app.workers.dev --token <secret>

# Show a specific run
npx workflow-cloudflare inspect run <runId> --url ... --token ...

# List steps for a run
npx workflow-cloudflare inspect steps --run-id <runId> --url ... --token ...

# Show a specific step
npx workflow-cloudflare inspect step <runId> <stepId> --url ... --token ...

# List events for a run
npx workflow-cloudflare inspect events --run-id <runId> --url ... --token ...

# List hooks
npx workflow-cloudflare inspect hooks --url ... --token ...

# Show a specific hook
npx workflow-cloudflare inspect hook <hookId> --url ... --token ...

# List streams for a run
npx workflow-cloudflare inspect streams --run-id <runId> --url ... --token ...

# Check SQLite storage size for a run's Durable Object
npx workflow-cloudflare inspect storage <runId> --url ... --token ...
```

### Flags

| Flag | Description |
|---|---|
| `--url <url>` | Deployed Worker URL (required) |
| `--token <token>` | Bearer token (or set `WORKFLOW_INSPECT_TOKEN` env var) |
| `--json` | Output raw JSON instead of formatted tables |
| `--limit <n>` | Pagination limit (default: 20) |
| `--run-id <id>` | Filter by run ID (for steps, events, streams) |
