# Local Testing

Test your workflows locally without deploying to Cloudflare. Both `wrangler dev` and `vite dev` use Miniflare to simulate the Cloudflare runtime.

## Using `workflow-cloudflare dev`

After building:

```bash
# Build both workers
workflow-cloudflare build --name <app-name>

# Start both workers locally
workflow-cloudflare dev
```

This starts:

- **Service worker** on port 8787 (workflow infrastructure)
- **Your worker** on port 8788 (your application)

The Service Binding between them is resolved locally by Miniflare.

Trigger a workflow through your worker:

```bash
curl -X POST http://localhost:8788/start \
  -H 'Content-Type: application/json' \
  -d '{"name": "World"}'
```

### Persistent state

By default, `wrangler dev` persists D1 and DO state in `.wrangler/state/`. This means your workflow runs survive dev server restarts. To start fresh:

```bash
rm -rf .wrangler/state/
workflow-cloudflare dev
```

## Using `vite dev`

If you have the Vite plugin set up (see [Project Setup](/vite/project-setup)):

```bash
npx vite dev
```

This gives you the same local Miniflare environment plus HMR for workflow files. Changes to workflow code are picked up without restarting.

## Writing automated tests with Vitest

Use `wrangler`'s `unstable_dev` API to create isolated Worker instances in tests:

```ts title="test/e2e.test.ts" lineNumbers
import { unstable_dev } from 'wrangler';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let worker;

beforeAll(async () => {
  worker = await unstable_dev('dist/_worker.js', {
    experimental: { disableExperimentalWarning: true },
    vars: { APP_ENV: 'test' },
  });
});

afterAll(async () => {
  await worker?.stop();
});

it('runs a workflow end-to-end', async () => {
  // Start a workflow run
  const startResp = await worker.fetch(
    '/.well-known/workflow/v1/flow',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflowName: 'helloWorkflow',
        input: 'Test',
      }),
    },
  );
  const { runId } = await startResp.json();

  // Poll for completion (local queue processing is near-instant)
  let status = 'running';
  for (let i = 0; i < 20 && status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const resp = await worker.fetch(
      `/.well-known/workflow/v1/flow?runId=${runId}`,
    );
    const body = await resp.json();
    status = body.status;
  }

  expect(status).toBe('completed');
});
```

## Debugging tips

### Wrangler logs

Use `wrangler tail` (against a deployed Worker) or watch the terminal output during `wrangler dev` for real-time logs.

### D1 inspection

Query the local D1 database directly:

```bash
wrangler d1 execute workflow-db --local --command "SELECT * FROM workflow_runs_index ORDER BY createdAt DESC LIMIT 10"
```

### Durable Object inspector

Miniflare exposes a DevTools inspector. When running `wrangler dev`, open `chrome://inspect` in Chrome and look for the Worker's DevTools target. You can set breakpoints inside Durable Object methods.

### Common issues

- **"Queue consumer not found"**: Ensure your `wrangler.toml` has both queue consumers configured. The builder generates these automatically.
- **"Workflow function not found"**: Ensure the function is exported and has the `"use workflow"` directive. Re-run the build.
- **D1 schema not applied**: The schema is created automatically on first request. If tables are missing, ensure the Worker started successfully and handled at least one request.
