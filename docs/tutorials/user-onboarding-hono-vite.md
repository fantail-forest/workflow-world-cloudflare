# Tutorial: User Onboarding (Hono + Vite)

This tutorial builds the same user onboarding workflow as the [Bare Worker tutorial](/tutorials/user-onboarding-worker), but uses Hono as the web framework and Vite as the build tool.

The workflow code is identical. The only differences are the framework and build tooling.

## Project setup

```bash
mkdir user-onboarding-hono && cd user-onboarding-hono
npm init -y
npm add hono workflow workflow-world-cloudflare @workflow/errors @workflow/world zod
npm add -D vite vite-plugin-workflow-cloudflare @cloudflare/vite-plugin @cloudflare/workers-types wrangler
```

## Write the workflow

Create `workflows/onboard-user.ts` -- this is identical to the bare worker tutorial:

```ts
import { FatalError, sleep } from "workflow";
import { getCloudflareEnv } from "workflow-world-cloudflare";

interface OnboardingInput {
  email: string;
  simulateActivation?: boolean;
}

interface User {
  id: string;
  email: string;
}

export async function onboardUser(input: OnboardingInput) {
  "use workflow";

  const user = await createUser(input.email);
  await sendEmail(user, "welcome");

  await sleep("10s");
  await sendEmail(user, "onboarding-tips");

  await sleep("15s");
  const activated = await checkActivation(user.id, input.simulateActivation);

  if (activated) {
    await sendEmail(user, "celebration");
  } else {
    await sendEmail(user, "re-engagement");
  }

  const emailsSent = await getEmailLog(user.id);
  return { userId: user.id, activated, emailsSent };
}

async function createUser(email: string): Promise<User> {
  "use step";

  if (!email?.includes("@")) {
    throw new FatalError("Invalid email address");
  }

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const id = crypto.randomUUID();
  const user = { id, email };

  await env.USERS.put(
    id,
    JSON.stringify({ ...user, activated: false, createdAt: new Date().toISOString() }),
  );

  return user;
}

async function sendEmail(user: User, type: string): Promise<void> {
  "use step";

  if (type === "welcome" && Math.random() < 0.3) {
    throw new Error("Email service temporarily unavailable");
  }

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const key = `emails:${user.id}`;
  const existing = (await env.USERS.get<string[]>(key, "json")) ?? [];
  existing.push(type);
  await env.USERS.put(key, JSON.stringify(existing));
}

async function checkActivation(userId: string, simulateActivation?: boolean): Promise<boolean> {
  "use step";

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  const record = await env.USERS.get<{ activated: boolean }>(userId, "json");
  return simulateActivation ?? record?.activated ?? false;
}

async function getEmailLog(userId: string): Promise<string[]> {
  "use step";

  const env = getCloudflareEnv<{ USERS: KVNamespace }>();
  return (await env.USERS.get<string[]>(`emails:${userId}`, "json")) ?? [];
}
```

## Write the Hono app

Create `src/index.ts`:

```ts
import { Hono } from "hono";
import { withWorkflow } from "workflow-world-cloudflare/with-workflow";
import { start, getRun } from "@workflow/core/runtime";
import { onboardUser } from "../workflows/onboard-user";

const app = new Hono();

app.post("/start", async (c) => {
  const body = await c.req.json<{ email: string; simulateActivation?: boolean }>();
  const run = await start(onboardUser, [body]);
  return c.json({ runId: run.runId });
});

app.get("/status", async (c) => {
  const runId = c.req.query("runId");
  if (!runId) {
    return c.json({ error: "Missing runId" }, 400);
  }
  const run = getRun(runId);
  const status = await run.status;
  const output = status === "completed" ? await run.output : undefined;
  return c.json({ runId, status, output });
});

app.get("/", (c) => {
  return c.text("User Onboarding API\n\nPOST /start\nGET /status?runId=...");
});

export default withWorkflow(app);
```

Note how `withWorkflow(app)` wraps the Hono app directly -- Hono already implements `fetch()`, so it works seamlessly.

With Vite, you can import workflow functions directly from source (`../workflows/onboard-user`) instead of from a generated client library. The Vite plugin handles the SWC transforms automatically.

## Configure Vite

Create `vite.config.ts`:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { workflowCloudflare } from "vite-plugin-workflow-cloudflare";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    workflowCloudflare({ appName: "user-onboarding" }),
    cloudflare({ persistState: true }),
  ],
});
```

## Configure custom bindings

Create `wrangler.app.toml`:

```toml
[[kv_namespaces]]
binding = "USERS"
id = "user-onboarding-kv"

[vars]
WORKFLOW_INSPECT_TOKEN = "dev-secret"
```

## Run locally

```bash
npx vite dev
```

Vite starts the local `workerd` runtime with HMR. Edit workflow files and the changes are picked up instantly.

## Test

The same curl commands work:

```bash
curl -X POST http://localhost:5173/start \
  -H 'Content-Type: application/json' \
  -d '{"email": "alice@example.com", "simulateActivation": true}'

curl "http://localhost:5173/status?runId=<runId>"
```

## Build for production

```bash
npx vite build
```

The Vite plugin invokes `CloudflareBuilder` during `vite build`, producing the same two-worker output as the CLI tutorial.

## Deploy

```bash
wrangler d1 create user-onboarding-workflow-db
wrangler queues create user-onboarding-workflow-runs
wrangler queues create user-onboarding-workflow-steps

wrangler deploy -c dist/service-worker/wrangler.toml
wrangler deploy
```

## Hono without Vite

If you prefer Hono with the CLI build instead of Vite, the code is the same. Just:

1. Remove the Vite config and dev dependencies
2. Use `workflow-cloudflare build` and `workflow-cloudflare dev` instead of `vite build` and `vite dev`
3. Import from `#workflows` instead of directly from source

```ts
import { onboardUser } from "#workflows";
```

Everything else stays the same.

## Next steps

- [Bare Worker Tutorial](/tutorials/user-onboarding-worker) -- Same workflow without a framework
- [HMR](/vite/hmr) -- How Vite hot module replacement works with workflows
- [Custom Bindings](/configuration/custom-bindings) -- Add more Cloudflare services
