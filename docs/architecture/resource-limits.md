# Monitoring Usage

Understanding how to measure your app's consumption of Cloudflare resources helps you anticipate limits and plan capacity before problems arise.

## D1 (Global Index)

The D1 database stores the global run index — denormalized metadata, steps, hooks, and streams for all workflow runs.

### Check database size

In the [Cloudflare dashboard](https://dash.cloudflare.com) under **Workers & Pages → D1**, select your database. The builder names it `{app-name}-workflow-db` — so if your app is named `billing`, look for `billing-workflow-db`. The overview shows total database size, row counts per table, and recent query metrics.

You can also query size directly:

```sql
-- Rows per table
SELECT name, (SELECT COUNT(*) FROM runs) as runs,
       (SELECT COUNT(*) FROM steps) as steps,
       (SELECT COUNT(*) FROM hooks) as hooks;

-- Approximate size in MB
SELECT page_count * page_size / 1024 / 1024 AS size_mb
FROM pragma_page_count(), pragma_page_size();
```

### Key metrics to watch

- **Database size**: D1 is capped at 10 GB on Workers Paid. Each completed run typically produces a few KB of index data, so ~1 million runs consumes roughly 1–5 GB.
- **Rows read/written per request**: Individual queries that scan large tables can hit per-query row limits. Monitor slow queries via the D1 dashboard's **Query Insights** tab.
- **Query latency**: The dashboard graphs p50/p99 latencies. A rising p99 often indicates table scans that need indexes or pagination.

### When to act

Add a cleanup job when your database approaches 5–7 GB, or when you see rising query latencies on run-listing endpoints:

```sql
DELETE FROM runs WHERE status = 'completed' AND createdAt < datetime('now', '-30 days');
```

## Durable Objects (RunDO, StreamDO)

Each workflow run gets its own `WorkflowRunDO` instance that stores its complete event log. `WorkflowStreamDO` instances handle streaming responses.

### Check storage per instance

Use the inspect CLI to query the SQLite storage size of any individual run's DO instance:

```bash
npx workflow-cloudflare inspect storage <runId> --url https://my-app.workers.dev --token <secret>
```

This returns the SQLite page count and total bytes used by that run's event log:

```json
{
  "runId": "wrun_01J...",
  "storageSizeBytes": 32768,
  "storageSizeKb": 32,
  "pageCount": 8,
  "pageSize": 4096
}
```

For aggregate DO storage across your account, go to **Workers & Pages → Durable Objects** in the dashboard. The **Storage** tab shows total GB used and GB-month billed.

### Key metrics to watch

- **Total DO storage (account-wide)**: Each `WorkflowRunDO` instance can hold up to 10 GB of SQLite data. Actual storage consumed per run depends heavily on step count and the size of each step's input/output payloads — a run with many steps that produce large outputs can easily reach tens of MB, while a run with small payloads may only use a few KB.
- **Request rates**: The dashboard shows requests per second per DO class. Individual DO instances can handle roughly 1,000 requests/second; above this, queue the work or shard across instances.
- **CPU time**: Workers Paid allows 30 seconds of _CPU time_ per request. Time spent in IO wait is not counted toward this limit. Long-running steps that approach this limit should be broken into smaller steps.

### When to act

::: warning Data retention
The **in-memory** DO instance is evicted after inactivity (hibernated after ~10 seconds, fully evicted after 70–140 seconds), but **SQLite storage persists indefinitely** and continues to accrue storage billing until explicitly deleted. Cloudflare does not automatically purge DO storage. See [Lifecycle of a Durable Object](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle) for details.
:::

If aggregate storage grows unexpectedly, look for runs that never reach a terminal state (`completed`, `failed`, `cancelled`) — their DO instances will retain their full event log indefinitely. Consider a periodic cleanup job that deletes the storage of completed runs beyond your retention window.

## Queues

The queue carries step invocation payloads and delayed wake-up messages between the Worker and Durable Objects.

### Check queue metrics

In the dashboard under **Workers & Pages → Queues**, select your queue. The metrics panel shows:

- **Messages delivered** — total throughput over time
- **Messages delayed** — how many messages are sitting in the delay buffer
- **Consumer errors** — failed deliveries being retried
- **Queue backlog** — depth of unprocessed messages (rising backlog = consumer can't keep up)

### Key metrics to watch

- **Queue backlog**: A growing backlog means your consumer Worker is processing slower than messages arrive. This delays step execution. Scale your consumer's concurrency or optimize step handlers.
- **Message size**: Each message is capped at 128 KB. If workflow inputs or step arguments are large, store the payload in R2 or D1 and pass a reference key in the message instead.
- **Delay accuracy**: Sleeps longer than 24 hours are implemented via delay chaining (re-enqueuing with capped delays). The backlog metric tells you how many delayed messages are in flight at any time.
- **Consumer errors**: Repeated errors on the same message indicate a poisoned payload. Check your Worker logs (via **Workers & Pages → your Worker → Logs**) for the underlying exception.

### When to act

By default Cloudflare [auto-scales consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) based on backlog depth and growth rate — you do not need to set `max_concurrency` to get scaling. Leaving it unset is the right choice for most apps.

`max_concurrency` is a **cap**, not a floor. Set it when you need to deliberately *limit* parallelism — for example, if your step handlers call a rate-limited external API and you need to control the number of simultaneous calls. The maximum allowed value is 10.

If your backlog is growing and you haven't set `max_concurrency`, the bottleneck is likely in step processing time rather than consumer concurrency. Use this formula to estimate your sustained throughput:

```
throughput (msg/s) = max_concurrency × batch_size / avg_step_duration_seconds
```

For example: 5 concurrent consumers × 10-message batches / 2 seconds per step = 25 messages/second. If that is below your arrival rate, your steps are the bottleneck — optimise them or increase `max_concurrency` (up to 10) if you have headroom.

Note: Cloudflare only checks whether to scale up *after* a full batch completes, so a very long-running step can briefly delay scaling decisions.

## Workers Analytics

For a holistic view of request rates, CPU time, and error rates across all Workers (the main worker, DO classes, and queue consumer), use **Workers & Pages → your Worker → Analytics**.

The **Invocations** chart shows requests per second. The **Errors** chart flags 4xx/5xx responses and uncaught exceptions. CPU time histograms show whether any requests are approaching the 30-second limit.

### Logging

Enable [Workers Logpush](https://developers.cloudflare.com/workers/observability/logpush/) to stream structured logs to an external destination (Datadog, Grafana, S3, etc.) for long-term retention and alerting.

For quick debugging, the real-time **Logs** tab on your Worker surfaces recent invocations and their console output without any setup.
