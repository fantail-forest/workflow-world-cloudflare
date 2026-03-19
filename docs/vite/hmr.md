# Hot Module Replacement

The workflow Vite plugin provides HMR for workflow and step files. When you edit a workflow file, the SWC transform re-runs and the `workerd` runtime picks up the changes without a full restart.

## What triggers HMR

Any change to a file in the configured workflow directories (default: `workflows/`) triggers:

1. File change detected by Vite's watcher
2. SWC transform re-runs on all workflow files
3. Virtual modules (`virtual:workflow-code`, `virtual:workflow-functions`) are invalidated
4. `workerd` picks up the new modules

## What gets preserved

With `persistState: true` in the cloudflare plugin config, the following survive HMR:

- D1 database contents (the global index)
- Durable Object storage (per-run event logs)
- Queue state

This means in-progress workflow runs continue from where they left off after a code change, as long as the event log is compatible with the new code.

## SWC transform pipeline

During dev, the plugin runs the same SWC transform used by `workflow build`:

1. Each workflow file is transformed individually via `applySwcTransform()`
2. Workflow names are extracted from `__private_workflows.set()` calls in the transformed output
3. The `virtual:workflow-code` module exports the concatenated transformed code
4. The `virtual:workflow-functions` module exports static imports of each workflow function

The module aliases (`node:vm` -> polyfill, etc.) are injected via Vite's `resolve.alias` config, so they apply to both the initial build and HMR updates.

## Known limitations

- **Full page reload on structural changes**: Adding or removing workflow functions (not just editing existing ones) may require a full page reload since it changes the set of static imports.
- **Queue consumer restart**: Changes to queue consumer logic may not take effect until the next message delivery, since the consumer is a separate execution context.
- **Large workflow files**: Very large workflow files with many steps may have noticeable SWC transform times on save. Consider splitting into smaller files.
