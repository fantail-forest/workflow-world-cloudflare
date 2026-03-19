# Getting Started

This guide walks you through deploying a Workflow DevKit app to Cloudflare Workers.

## Prerequisites

- Node.js 18+
- [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A Cloudflare account with Workers Paid plan (required for Durable Objects and Queues)

## Install packages

```bash
npm add @workflow/core workflow-world-cloudflare
npm add -D @cloudflare/workers-types wrangler
```

## Write a workflow

Create a file at `workflows/hello.ts`:

```ts title="workflows/hello.ts" lineNumbers
export async function helloWorkflow(name: string) {
  "use workflow";
  const greeting = await greet(name);
  return greeting;
}

async function greet(name: string) {
  "use step";
  return `Hello, ${name}! The time is ${new Date().toISOString()}`;
}
```

## Build for Cloudflare

```bash
npx workflow-cloudflare build --name my-app
```

The `--name` flag sets the application name. All account-scoped Cloudflare resources are namespaced under this name (see [Resource namespacing](/configuration/#resource-namespacing)).

You can also build via Vite -- see [Using with Vite](/vite/).

This produces:

- `dist/_worker.js` - bundled Worker entry point with polyfills and module aliases
- `wrangler.toml` - generated config with all required bindings pre-filled

## Create Cloudflare resources

Before the first deploy, create the D1 database and Queues. The resource names are derived from your app name:

```bash
# Create the D1 database
wrangler d1 create my-app-workflow-db

# Create the queues
wrangler queues create my-app-workflow-runs
wrangler queues create my-app-workflow-steps
```

Copy the D1 database ID from the output and update `wrangler.toml`:

```toml
[[d1_databases]]
binding = "WORKFLOW_DB"
database_name = "my-app-workflow-db"
database_id = "your-database-id-here"
```

The D1 index tables are created automatically on first request -- no manual schema setup is needed.

## Deploy

```bash
wrangler deploy
```

## Trigger a workflow run

```bash
curl -X POST https://your-worker.your-subdomain.workers.dev/.well-known/workflow/v1/flow \
  -H 'Content-Type: application/json' \
  -d '{"workflowName": "helloWorkflow", "input": "World"}'
```

## Verify completion

Check the workflow run status:

```bash
curl https://your-worker.your-subdomain.workers.dev/.well-known/workflow/v1/flow?runId=<run-id>
```

## Inspect workflow runs

To inspect runs from the terminal, set a `WORKFLOW_INSPECT_TOKEN` secret on your Worker:

```bash
wrangler secret put WORKFLOW_INSPECT_TOKEN
```

Then use the inspect CLI:

```bash
npx workflow-cloudflare inspect runs \
  --url https://my-app.your-subdomain.workers.dev \
  --token <your-secret>
```

See [Inspecting runs](/configuration/#inspecting-runs) for the full list of inspect subcommands.

## Next steps

- [Configuration](/configuration/) - customize your wrangler config, add bindings, and enable inspect
- [Architecture](/architecture/) - understand how Workflow DevKit maps to Cloudflare resources
- [Vite Integration](/vite/project-setup) - set up local dev with HMR
- [Testing](/testing/) - test your workflows locally
