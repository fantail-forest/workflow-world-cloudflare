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
    workflowCloudflare(),
    cloudflare(),
  ],
})
```

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
   - `virtual:workflow-functions` — static import map keyed by workflow function name, which populates `globalThis.__workflow_cloudflare_functions`
3. Injects `resolve.alias` entries for `node:vm`, `node:module`, and `@vercel/functions`, pointing them to the polyfills in `workflow-world-cloudflare`
4. Excludes `workflow-world-cloudflare` from `optimizeDeps`
5. Watches workflow directories; on any file change, re-runs the SWC transform and invalidates the virtual modules, triggering an HMR reload in `workerd`

### Production (`vite build`)

Delegates to `CloudflareBuilder` (from `workflow-world-cloudflare/builder`), which produces:
- `dist/_worker.js` — the bundled Worker
- `wrangler.toml` (or `wrangler.jsonc`) — the generated Cloudflare config

This is equivalent to running `npx workflow-cloudflare build` directly.

## HMR

Any file change in a watched workflow directory triggers:
1. SWC transform re-runs
2. `virtual:workflow-code` and `virtual:workflow-functions` are invalidated
3. `workerd` reloads

With `persistState: true` on `@cloudflare/vite-plugin`, D1, Durable Object storage, and queue state survive reloads — in-progress runs continue after a code change.

**Limitations:**

- Adding or removing workflow functions may require a full server restart, since doing so changes the static import list
- Queue consumer changes take effect on the next message delivery, not immediately
- Large workflow files may have a noticeable SWC transform time on each save
