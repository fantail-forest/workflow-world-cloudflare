# vite-plugin-workflow-cloudflare

Vite plugin for the Workflow DevKit targeting Cloudflare Workers. Handles SWC transformation in development with HMR support, and invokes `CloudflareBuilder` for production builds.

## Installation

```sh
npm install -D vite-plugin-workflow-cloudflare
```

Peer dependencies: `vite ^5 || ^6`, `workflow-world-cloudflare`

## Usage

`workflowCloudflare()` must be placed **before** `@cloudflare/vite-plugin` in the plugins array.

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin'
import { workflowCloudflare } from 'vite-plugin-workflow-cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    workflowCloudflare({ appName: 'my-app' }),
    cloudflare({ persistState: true }),
  ],
})
```

Your worker wraps its default export with `withWorkflow()`:

```ts
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start } from "@workflow/core/runtime";
import { myWorkflow } from "../workflows/my-workflow";

export default withWorkflow({
  async fetch(request, env, ctx) {
    const run = await start(myWorkflow, [await request.json()]);
    return Response.json({ runId: run.runId });
  },
});
```

With Vite, import workflow functions directly from source — the plugin handles SWC transforms.

## Options

```ts
interface WorkflowCloudflareOptions {
  dirs?: string[]        // workflow directories to watch (default: ['workflows'])
  workingDir?: string    // root for resolving dirs (default: process.cwd())
  appName?: string       // Cloudflare app/worker name
  wranglerFormat?: 'toml' | 'jsonc'  // output format for generated config
}
```

## Behavior

### Development (`vite dev`)

1. On startup, runs the SWC transform over all files in the configured workflow directories
2. Serves two virtual modules:
   - `virtual:workflow-code` — concatenated transformed workflow source
   - `virtual:workflow-functions` — static import map keyed by workflow function name
3. Injects `resolve.alias` entries for `node:vm`, `node:module`, and `@vercel/functions`, pointing to polyfills
4. Excludes `workflow-world-cloudflare` from `optimizeDeps`
5. Watches workflow directories; on any file change, re-runs the SWC transform and invalidates virtual modules for HMR

### Production (`vite build`)

Delegates to `CloudflareBuilder` to produce the two-worker output:

- `dist/service-worker/_worker.js` — the workflow service worker
- `dist/service-worker/wrangler.toml` — service worker config
- `wrangler.toml` — user worker config (with Service Binding)

This is equivalent to running `npx workflow-cloudflare build` directly.

## HMR

Any file change in a watched workflow directory triggers:
1. SWC transform re-runs
2. `virtual:workflow-code` and `virtual:workflow-functions` are invalidated
3. `workerd` reloads

With `persistState: true` on `@cloudflare/vite-plugin`, D1, Durable Object storage, and queue state survive reloads.

**Limitations:**

- Adding or removing workflow functions may require a full server restart
- Queue consumer changes take effect on the next message delivery
- Large workflow files may have a noticeable SWC transform time on each save
