import cp from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const e2eDir = __dirname;

let wranglerProc: cp.ChildProcess | null = null;
let baseUrl: string;

async function buildWorker() {
  return new Promise<void>((resolve, reject) => {
    const proc = cp.spawn("node", ["--import", "tsx", "build.mts"], {
      cwd: e2eDir,
      stdio: "pipe",
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Build failed (exit ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function startWrangler(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = cp.spawn(
      "npx",
      [
        "wrangler",
        "dev",
        "--port",
        "0",
        "--config",
        join(e2eDir, "wrangler.toml"),
        "--persist-to",
        join(e2eDir, ".wrangler-persist"),
      ],
      {
        cwd: e2eDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NO_COLOR: "1",
        },
      },
    );
    wranglerProc = proc;

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for wrangler dev.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30_000);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Ready on (https?:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/Ready on (https?:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!baseUrl) {
        clearTimeout(timeout);
        reject(new Error(`wrangler exited with code ${code} before ready.\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

describe("workflow-world-cloudflare e2e", () => {
  beforeAll(async () => {
    rmSync(join(e2eDir, ".wrangler-persist"), { recursive: true, force: true });
    await buildWorker();
    baseUrl = await startWrangler();
  }, 60_000);

  afterAll(() => {
    if (wranglerProc) {
      wranglerProc.kill("SIGTERM");
      wranglerProc = null;
    }
  });

  async function api(path: string, opts?: { method?: string; body?: unknown }) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts?.method ?? "GET",
      headers: opts?.body ? { "content-type": "application/json" } : undefined,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });
    return res;
  }

  test("health check", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("create and get a run", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "test-workflow", input: { hello: "world" } },
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      runId: string;
      status: string;
    };
    expect(created.runId).toBeTruthy();
    expect(created.status).toBe("pending");

    const getRes = await api(`/runs/${encodeURIComponent(created.runId)}`);
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as {
      runId: string;
      status: string;
      workflowName: string;
    };
    expect(fetched.runId).toBe(created.runId);
    expect(fetched.workflowName).toBe("test-workflow");
    expect(fetched.status).toBe("pending");
  });

  test("create run and add events", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "event-test", input: {} },
    });
    const { runId } = (await createRes.json()) as { runId: string };

    const startRes = await api(`/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: { eventType: "run_started" },
    });
    expect(startRes.status).toBe(200);

    const completeRes = await api(`/runs/${encodeURIComponent(runId)}/events`, {
      method: "POST",
      body: {
        eventType: "run_completed",
        eventData: { output: new Array(4).fill(0) },
      },
    });
    expect(completeRes.status).toBe(200);

    const getRes = await api(`/runs/${encodeURIComponent(runId)}`);
    const run = (await getRes.json()) as { status: string };
    expect(run.status).toBe("completed");

    const eventsRes = await api(`/runs/${encodeURIComponent(runId)}/events`);
    const events = (await eventsRes.json()) as {
      data: { eventType: string }[];
    };
    expect(events.data.length).toBeGreaterThanOrEqual(3);
    const types = events.data.map((e) => e.eventType);
    expect(types).toContain("run_created");
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
  });

  test("list runs", async () => {
    const res = await api("/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { runId: string; workflowName: string }[];
    };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test("stream write and read", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "stream-test", input: {} },
    });
    const { runId } = (await createRes.json()) as { runId: string };

    const writeRes = await api(`/runs/${encodeURIComponent(runId)}/streams/test-stream`, {
      method: "POST",
      body: { chunks: ["hello ", "world"], close: true },
    });
    expect(writeRes.status).toBe(200);

    const readRes = await api(`/runs/${encodeURIComponent(runId)}/streams/test-stream`);
    expect(readRes.status).toBe(200);
    const text = await readRes.text();
    expect(text).toBe("hello world");
  });

  test("node:vm polyfill works in workerd runtime", async () => {
    const res = await api("/test/vm-polyfill", { method: "POST", body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contextReturned: boolean;
      workflowResult: { sum: number };
      mathRandomStillWorks: boolean;
      dateNowStillWorks: boolean;
      unrecognizedThrew: boolean;
      missingThrew: boolean;
    };
    // Pattern 1: createContext returns the context object via runInContext('globalThis', ctx)
    expect(body.contextReturned).toBe(true);
    // Pattern 2: workflow function was looked up and executed correctly
    expect(body.workflowResult).toEqual({ sum: 7 });
    // Globals are restored after workflow execution
    expect(body.mathRandomStillWorks).toBe(true);
    expect(body.dateNowStillWorks).toBe(true);
    // Unrecognized code patterns throw
    expect(body.unrecognizedThrew).toBe(true);
    // Missing workflow functions throw
    expect(body.missingThrew).toBe(true);
  });

  test("cbor-x encode/decode works without unsafe-eval", async () => {
    const testData = {
      name: "test",
      value: 42,
      nested: { arr: [1, "two", true, null] },
    };
    const res = await api("/test/cbor", {
      method: "POST",
      body: { data: testData },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      encodedSize: number;
      roundTripped: boolean;
      allPassed: boolean;
      results: { label: string; roundTripped: boolean }[];
    };
    expect(body.encodedSize).toBeGreaterThan(0);
    expect(body.roundTripped).toBe(true);
    expect(body.allPassed).toBe(true);
    // Verify each type round-trips correctly
    for (const result of body.results) {
      expect(result.roundTripped).toBe(true);
    }
  });

  test("queue consumer re-enqueues with capped delay on timeoutSeconds", async () => {
    const res = await api("/test/queue-reenqueue", {
      method: "POST",
      body: { timeoutSeconds: 100_000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wasReenqueued: boolean;
      requestedTimeout: number;
      effectiveDelay: number;
      wasClamped: boolean;
      attemptIncremented: boolean;
    };
    expect(body.wasReenqueued).toBe(true);
    expect(body.requestedTimeout).toBe(100_000);
    expect(body.effectiveDelay).toBe(86_400);
    expect(body.wasClamped).toBe(true);
    expect(body.attemptIncremented).toBe(true);
  });

  test("queue consumer re-enqueues within-limit delay unchanged", async () => {
    const res = await api("/test/queue-reenqueue", {
      method: "POST",
      body: { timeoutSeconds: 3600 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      wasReenqueued: boolean;
      effectiveDelay: number;
      wasClamped: boolean;
    };
    expect(body.wasReenqueued).toBe(true);
    expect(body.effectiveDelay).toBe(3600);
    expect(body.wasClamped).toBe(false);
  });

  test("stream reader can disconnect mid-stream without breaking writer", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "disconnect-test", input: {} },
    });
    const { runId } = (await createRes.json()) as { runId: string };

    const res = await api("/test/stream-disconnect", {
      method: "POST",
      body: { runId, streamName: "disconnect-stream", chunkCount: 5 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chunksRead: number;
      readChunks: string[];
      readerCancelled: boolean;
      totalWritten: number;
    };
    // Reader consumed only 1 chunk before cancelling
    expect(body.chunksRead).toBe(1);
    expect(body.readChunks).toHaveLength(1);
    expect(body.readerCancelled).toBe(true);
    // Writer side wrote all chunks
    expect(body.totalWritten).toBe(5);
  });

  test("getCloudflareEnv() returns env bindings inside context", async () => {
    const res = await api("/test/env-scoping");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasDb: boolean; bindingName: string };
    expect(body.hasDb).toBe(true);
    expect(body.bindingName).toBe("WORKFLOW_DB");
  });

  test("getCloudflareEnv() is accessible inside ALS context", async () => {
    const res = await api("/test/env-outside-context");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { insideContext: boolean };
    expect(body.insideContext).toBe(true);
  });

  test("queue delay is clamped to 24h maximum", async () => {
    const res = await api("/test/queue-delay", {
      method: "POST",
      body: { delaySeconds: 100_000 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requestedDelay: number;
      effectiveDelay: number;
      maxDelay: number;
      wasClamped: boolean;
    };
    expect(body.requestedDelay).toBe(100_000);
    expect(body.effectiveDelay).toBe(86_400);
    expect(body.wasClamped).toBe(true);
  });

  test("queue accepts delay within 24h limit", async () => {
    const res = await api("/test/queue-delay", {
      method: "POST",
      body: { delaySeconds: 3600 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      requestedDelay: number;
      effectiveDelay: number;
      wasClamped: boolean;
    };
    expect(body.requestedDelay).toBe(3600);
    expect(body.effectiveDelay).toBe(3600);
    expect(body.wasClamped).toBe(false);
  });

  test("stream read from open (unclosed) stream returns written data", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "open-stream-test", input: {} },
    });
    const { runId } = (await createRes.json()) as { runId: string };

    // Write chunks without closing
    const writeRes = await api("/test/stream-open-read", {
      method: "POST",
      body: { runId, streamName: "open-stream", chunks: ["partial ", "data"] },
    });
    expect(writeRes.status).toBe(200);

    // Now close the stream and read it
    await api(`/runs/${encodeURIComponent(runId)}/streams/open-stream`, {
      method: "POST",
      body: { chunks: [" end"], close: true },
    });

    const readRes = await api(`/runs/${encodeURIComponent(runId)}/streams/open-stream`);
    expect(readRes.status).toBe(200);
    const text = await readRes.text();
    expect(text).toBe("partial data end");
  });

  test("list streams by run", async () => {
    const createRes = await api("/runs", {
      method: "POST",
      body: { workflowName: "stream-list-test", input: {} },
    });
    const { runId } = (await createRes.json()) as { runId: string };

    await api(`/runs/${encodeURIComponent(runId)}/streams/stream-a`, {
      method: "POST",
      body: { chunks: ["a"], close: true },
    });
    await api(`/runs/${encodeURIComponent(runId)}/streams/stream-b`, {
      method: "POST",
      body: { chunks: ["b"], close: true },
    });

    const listRes = await api(`/runs/${encodeURIComponent(runId)}/streams`);
    expect(listRes.status).toBe(200);
    const data = (await listRes.json()) as { streams: string[] };
    expect(data.streams.sort()).toEqual(["stream-a", "stream-b"]);
  });
});
