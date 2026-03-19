# Vite Project Setup

The `vite-plugin-workflow-cloudflare` plugin integrates the Workflow DevKit build pipeline into Vite, enabling local development with `@cloudflare/vite-plugin` and `workerd`.

## Install dependencies

```bash
npm add @workflow/core workflow-world-cloudflare
npm add -D vite-plugin-workflow-cloudflare @cloudflare/vite-plugin vite wrangler
```

## Configure Vite

Create a `vite.config.ts` at your project root:

```ts title="vite.config.ts" lineNumbers
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { workflowCloudflare } from 'vite-plugin-workflow-cloudflare';

export default defineConfig({
  plugins: [
    workflowCloudflare(),
    cloudflare({
      configPath: './wrangler.toml',
      persistState: true,
    }),
  ],
});
```

The `workflowCloudflare()` plugin must come before `cloudflare()` in the plugins array. It processes workflow files with SWC and injects the module aliases that `cloudflare()` needs.

## Plugin options

```ts
workflowCloudflare({
  dirs: ['workflows'],      // Directories to scan for workflow files (default: ['workflows'])
  workingDir: process.cwd(), // Project root (default: process.cwd())
})
```

## Directory structure

```
project/
  vite.config.ts
  wrangler.toml
  wrangler.app.toml          # Optional: your custom bindings
  workflows/
    hello.ts
    data-pipeline.ts
  src/
    index.ts                 # Worker entry point (optional if using builder)
```

## Wrangler config for local dev

You need a `wrangler.toml` for local development. You can either:

1. Generate one with `workflow-cloudflare build --name <app-name>` (recommended for consistency)
2. Write one manually for dev-only use

For local dev, D1 and DO state is persisted automatically when `persistState: true` is set in the cloudflare plugin. This means your workflow state survives restarts.

## Starting the dev server

```bash
npx vite dev
```

This starts a local `workerd` runtime via `@cloudflare/vite-plugin` with:

- Your workflow files compiled via SWC
- Module aliases applied for `node:vm`, `node:module`, `@vercel/functions`, `cbor-x`
- D1, Durable Objects, and Queues simulated locally via Miniflare

Changes to workflow files trigger an HMR update. See [HMR](/vite/hmr) for details.
