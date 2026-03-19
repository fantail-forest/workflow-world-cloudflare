---
layout: home
hero:
  name: Workflow DevKit for Cloudflare
  tagline: Deploy durable, long-running workflows to Cloudflare Workers
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Architecture
      link: /architecture/
features:
  - title: No Unsafe Eval
    details: Build-time module aliasing makes it work on Workers without unsafe-eval.
  - title: D1 + Durable Objects
    details: Per-run state in Durable Objects with SQLite gives you single-threaded atomicity. D1 provides the global index for cross-run queries.
  - title: Queue-based Scheduling
    details: Cloudflare Queues handle workflow and step invocations. Automatic delay chaining supports sleeps up to any duration.
  - title: Vite + HMR
    details: First-class Vite plugin with hot module replacement. Edit workflow files and see changes instantly via workerd.
---

# What is this?

`workflow-world-cloudflare` is a deployment target for Vercel's [Workflow DevKit](https://useworkflow.dev) framework. It maps every Workflow DevKit concept to a Cloudflare primitive:

| Workflow DevKit | Cloudflare Resource |
|---|---|
| Storage (per-run state) | Durable Object with SQLite |
| Storage (global index) | D1 database |
| Queue (scheduling) | Cloudflare Queues |
| Streaming | StreamDO (Durable Object) |

Any app built with the Workflow DevKit can target Cloudflare by changing the build target - no code changes required.
