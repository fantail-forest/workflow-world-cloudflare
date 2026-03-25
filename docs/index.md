---
layout: home
hero:
  name: Cloudflare World for Workflow DevKit
  tagline: Deploy durable workflows written with Workflow DevKit to Cloudflare workers
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /architecture/
features:
  - title: Clean DX with withWorkflow()
    details: Wrap your Worker with withWorkflow() and use start() and getRun() — no boilerplate, no infrastructure code.
  - title: Two-Worker Architecture
    details: Your app worker connects to a generated service worker via Service Binding. Workflow infra stays separate and secure.
  - title: D1 + Durable Objects
    details: Per-run state in Durable Objects with SQLite gives you single-threaded atomicity. D1 provides the global index for cross-run queries.
  - title: Vite + HMR
    details: First-class Vite plugin with hot module replacement. Edit workflow files and see changes instantly via workerd.
---

# What is this?

`workflow-world-cloudflare` is a deployment target for Vercel's [Workflow DevKit](https://useworkflow.dev) framework. It maps every Workflow DevKit concept to a Cloudflare primitive using a two-worker architecture:

| Workflow DevKit | Cloudflare Resource |
|---|---|
| Storage (per-run state) | Durable Object with SQLite |
| Storage (global index) | D1 database |
| Queue (scheduling) | Cloudflare Queues |
| Streaming | StreamDO (Durable Object) |
| World proxy | Service Binding (RPC) |

Your worker uses `withWorkflow()` to connect to a generated workflow service worker. The DX matches the Workflow DevKit patterns on other platforms:

```ts
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start } from "@workflow/core/runtime";
import { myWorkflow } from "#workflows";

export default withWorkflow({
  async fetch(request, env, ctx) {
    const run = await start(myWorkflow, [{ name: "Alice" }]);
    return Response.json({ runId: run.runId });
  },
});
```
