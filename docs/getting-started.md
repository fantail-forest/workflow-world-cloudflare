# Getting Started

This guide walks you through deploying a Workflow DevKit app to Cloudflare Workers using the two-worker architecture.

## Prerequisites

- Node.js 18+
- [wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm i -g wrangler`)
- A Cloudflare account with Workers Paid plan (required for Durable Objects and Queues)

## Install packages

```bash
npm add workflow workflow-world-cloudflare @workflow/errors @workflow/world zod
npm add -D @cloudflare/workers-types wrangler
```

Add a `#workflows` import map to your `package.json`:

```json
{
  "imports": {
    "#workflows": "./dist/client.js"
  }
}
```

## Write a workflow

Create a file at `workflows/hello.ts`:

```ts
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

## Write your worker

Create `src/worker.ts`:

```ts
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start, getRun } from "@workflow/core/runtime";
import { helloWorkflow } from "#workflows";

export default withWorkflow({
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const { name } = await request.json();
      const run = await start(helloWorkflow, [name]);
      return Response.json({ runId: run.runId });
    }

    if (url.pathname === "/status") {
      const runId = url.searchParams.get("runId");
      if (!runId) return Response.json({ error: "Missing runId" }, { status: 400 });
      const run = getRun(runId);
      return Response.json({ status: await run.status, output: await run.output });
    }

    return new Response("Hello Workflow API");
  },
});
```

`withWorkflow()` sets up the connection to the generated workflow service worker via a Service Binding. You use `start()` and `getRun()` from `workflow/api` to interact with workflows -- no boilerplate, no infrastructure code.

## Configure your worker

Create `wrangler.app.toml`:

```toml
main = "src/worker.ts"
```

## Build

```bash
npx workflow-cloudflare build --name my-app
```

The `--name` flag sets the application name. All account-scoped Cloudflare resources are namespaced under this name (see [Resource namespacing](/configuration/#resource-namespacing)).

You can also build via Vite -- see [Using with Vite](/vite/).

This produces:

```
dist/
  service-worker/          # Generated workflow service worker
    _worker.js             # Entry with DOs, queue handler, RPC entrypoint
    wrangler.toml          # Service worker config
  client.js                # Client library with workflow stubs
wrangler.toml              # Your worker config (with Service Binding)
```

## Create Cloudflare resources

Before the first deploy, create the D1 database and Queues:

```bash
wrangler d1 create my-app-workflow-db
wrangler queues create my-app-workflow-runs
wrangler queues create my-app-workflow-steps
```

Copy the D1 database ID from the output and update `dist/service-worker/wrangler.toml`.

## Deploy

Deploy both workers:

```bash
# Deploy the workflow service worker
wrangler deploy -c dist/service-worker/wrangler.toml

# Deploy your application worker
wrangler deploy
```

## Run locally

```bash
npx workflow-cloudflare dev
```

This starts both workers locally with Service Bindings resolved by Miniflare.

## Trigger a workflow

```bash
curl -X POST http://localhost:8788/start \
  -H 'Content-Type: application/json' \
  -d '{"name": "World"}'
```

## Inspect workflow runs

Set a `WORKFLOW_INSPECT_TOKEN` secret (or use the `dev-secret` var in `wrangler.app.toml` for local dev):

```bash
npx workflow-cloudflare inspect runs \
  --url http://localhost:8787 \
  --token dev-secret
```

## Next steps

- [Tutorials](/tutorials/user-onboarding-worker) -- Full walkthrough with a real-world workflow
- [Configuration](/configuration/) -- Customize your wrangler config, add bindings, and enable inspect
- [Architecture](/architecture/) -- Understand the two-worker model and Service Bindings
- [Vite Integration](/vite/project-setup) -- Set up local dev with HMR
