# Testing

This section covers how to test workflows targeting the Cloudflare world, both interactively during development and with automated test suites.

## Interactive testing

Use `workflow-cloudflare dev` or `vite dev` to run your workers locally with Miniflare. Both simulate D1, Durable Objects, and Queues locally, so you can trigger and observe workflow runs without deploying.

See [Local Testing](/testing/local-testing) for detailed instructions.

## Automated testing

Write Vitest tests that use Miniflare's API to create isolated Worker environments:

```ts title="test/workflow.test.ts" lineNumbers
import { unstable_dev } from 'wrangler';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('onboarding workflow', () => {
  let worker;

  beforeAll(async () => {
    worker = await unstable_dev('src/worker.ts', {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterAll(async () => {
    await worker?.stop();
  });

  it('should start a workflow run', async () => {
    const resp = await worker.fetch('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@example.com' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.runId).toBeDefined();
  });
});
```

## Unit testing polyfills

The polyfill modules have their own unit tests that run in standard Node.js without Miniflare:

```bash
cd packages/workflow-world-cloudflare && npm test
```

These tests cover:
- `node:vm` polyfill pattern matching and global override behavior
- `node:module` polyfill no-op behavior
- `@vercel/functions` polyfill AsyncLocalStorage delegation
- Environment storage and `getCloudflareEnv()` scoping
- Wrangler config deep-merge logic
