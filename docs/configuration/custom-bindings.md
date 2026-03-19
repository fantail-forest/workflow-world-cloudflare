# Custom Bindings

You can add any Cloudflare binding (Hyperdrive, KV, R2, AI, etc.) to your workflows via the override file and access them from step functions using `getCloudflareEnv()`.

::: warning
Bindings are only accessible in step functions. Workflow functions run in a sandboxed context without I/O access.
:::

## Adding bindings

Add your bindings to `wrangler.app.toml` or `wrangler.app.jsonc`. The builder merges them into the final config alongside the required workflow bindings.

## Typing your environment

Define a custom `Env` interface and pass it as a type parameter to `getCloudflareEnv<T>()`:

```ts title="env.d.ts" lineNumbers
interface Env {
  APP_DB: Hyperdrive;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  AI: Ai;
}
```

## Accessing bindings from step functions

Use `getCloudflareEnv<Env>()` inside any step function:

```ts title="workflows/data-pipeline.ts" lineNumbers
import { getCloudflareEnv } from 'workflow-world-cloudflare';

export async function dataPipeline(sourceId: string) {
  "use workflow";
  const raw = await fetchData(sourceId);
  const processed = await transform(raw);
  await store(processed);
  return { sourceId, recordCount: processed.length };
}

async function fetchData(sourceId: string) {
  "use step";
  const env = getCloudflareEnv<Env>();
  const db = env.APP_DB;
  const resp = await fetch(db.connectionString, {
    method: 'POST',
    body: JSON.stringify({ query: `SELECT * FROM sources WHERE id = $1`, params: [sourceId] }),
  });
  return resp.json();
}

async function transform(raw: unknown[]) {
  "use step";
  const env = getCloudflareEnv<Env>();
  const result = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
    prompt: `Summarize: ${JSON.stringify(raw)}`,
  });
  return [result];
}

async function store(records: unknown[]) {
  "use step";
  const env = getCloudflareEnv<Env>();
  for (const record of records) {
    await env.ASSETS.put(
      `processed/${Date.now()}.json`,
      JSON.stringify(record),
    );
  }
}
```

## Binding examples

### Hyperdrive (Postgres)

```toml title="wrangler.app.toml"
[[hyperdrive]]
binding = "APP_DB"
id = "your-hyperdrive-id"
```

```ts lineNumbers
async function queryDb(sql: string) {
  "use step";
  const env = getCloudflareEnv<{ APP_DB: Hyperdrive }>();
  const resp = await fetch(env.APP_DB.connectionString);
  return resp.json();
}
```

### KV Namespace

```toml title="wrangler.app.toml"
[[kv_namespaces]]
binding = "CACHE"
id = "your-kv-id"
```

```ts lineNumbers
async function getCached(key: string) {
  "use step";
  const env = getCloudflareEnv<{ CACHE: KVNamespace }>();
  return env.CACHE.get(key, 'json');
}
```

### R2 Bucket

```toml title="wrangler.app.toml"
[[r2_buckets]]
binding = "ASSETS"
bucket_name = "my-assets"
```

```ts lineNumbers
async function uploadFile(key: string, data: ArrayBuffer) {
  "use step";
  const env = getCloudflareEnv<{ ASSETS: R2Bucket }>();
  await env.ASSETS.put(key, data);
}
```

### Workers AI

```toml title="wrangler.app.toml"
[ai]
binding = "AI"
```

```ts lineNumbers
async function classify(text: string) {
  "use step";
  const env = getCloudflareEnv<{ AI: Ai }>();
  return env.AI.run('@cf/huggingface/distilbert-sst-2-int8', { text });
}
```

### Environment Variables

```toml title="wrangler.app.toml"
[vars]
API_KEY = "sk-..."
APP_ENV = "production"
```

```ts lineNumbers
async function callExternalApi(payload: unknown) {
  "use step";
  const env = getCloudflareEnv<{ API_KEY: string }>();
  return fetch('https://api.example.com/data', {
    headers: { Authorization: `Bearer ${env.API_KEY}` },
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

## How it works

`getCloudflareEnv()` reads from an `AsyncLocalStorage` store that is populated on every incoming request and queue message. The generated Worker entry point wraps all handlers with `envStorage.run(env, ...)`, so the full `env` object (including both workflow bindings and your custom bindings) is always available inside step functions.

The function throws if called outside a request context (e.g., at module scope or inside a workflow function).
