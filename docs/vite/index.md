# Using with Vite

The `vite-plugin-workflow-cloudflare` plugin brings the Workflow DevKit's build pipeline into Vite, enabling both a fast local development experience with HMR and production builds.

## How it works

### Development (`vite dev`)

The plugin sits upstream of `@cloudflare/vite-plugin` in the Vite plugin chain:

1. **Watches** `workflows/` source files for changes
2. **Transforms** workflow and step code via the SWC compiler plugin
3. **Injects** esbuild aliases for polyfills (`node:vm`, `node:module`, `@vercel/functions`, `cbor-x`)
4. **Registers** pre-imported workflow functions in `globalThis.__workflow_cloudflare_functions`
5. **Feeds** the output into `@cloudflare/vite-plugin`, which runs it in local `workerd`

When a workflow or step file changes, the plugin re-runs the SWC transform and triggers Vite's HMR to reload the Worker with updated bundles.

### Production (`vite build`)

When you run `vite build`, the plugin invokes `CloudflareBuilder` to produce the full production Worker bundle. This is equivalent to running `npx workflow-cloudflare build` directly.

To configure the production build, pass `appName` and optionally `wranglerFormat` to the plugin:

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { workflowCloudflare } from 'vite-plugin-workflow-cloudflare';

export default defineConfig({
  plugins: [
    workflowCloudflare({
      appName: 'my-app',
      wranglerFormat: 'toml',
    }),
    cloudflare({ configPath: './wrangler.toml', persistState: true }),
  ],
});
```

After `vite build` completes, you'll find:
- `dist/_worker.js` -- the production Worker bundle
- `wrangler.toml` (or `.jsonc`) -- the generated wrangler config

Deploy with `wrangler deploy` as usual.

## Next steps

- [Project Setup](./project-setup) -- Installing and configuring the plugins
- [HMR](./hmr) -- How hot module replacement works and its limitations
