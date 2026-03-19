import { createContext, runInContext } from "node:vm";
import { Decoder, Encoder } from "cbor-x";
import {
  BINDING_NAMES,
  createCloudflareWorld,
  envStorage,
  executionContextStorage,
  getCloudflareEnv,
} from "../../../src/index.js";
import { WorkflowRunDO } from "../../../src/run-do.js";
import { WorkflowStreamDO } from "../../../src/stream-do.js";

export { WorkflowRunDO, WorkflowStreamDO };

type World = Awaited<ReturnType<typeof createCloudflareWorld>>;

function matchCapture(path: string, pattern: RegExp): string[] | null {
  const m = path.match(pattern);
  if (!m) return null;
  return m.slice(1).map((g) => decodeURIComponent(g ?? ""));
}

// --- /runs route handlers ---

async function handleRunsRoot(request: Request, world: World): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json()) as { workflowName: string; input: unknown };
    const result = await world.events.create(null, {
      eventType: "run_created",
      eventData: { deploymentId: "e2e-test", workflowName: body.workflowName, input: new Uint8Array([1, 2, 3]) },
    });
    return Response.json({ runId: result.run?.runId, status: result.run?.status });
  }
  if (request.method === "GET") {
    const result = await world.runs.list({ resolveData: "none" });
    return Response.json({
      data: result.data.map((r) => ({ runId: r.runId, status: r.status, workflowName: r.workflowName })),
    });
  }
  return Response.json({ error: "Method Not Allowed" }, { status: 405 });
}

async function handleSingleRun(_request: Request, world: World, runId: string): Promise<Response> {
  const run = await world.runs.get(runId);
  return Response.json({ runId: run.runId, status: run.status, workflowName: run.workflowName });
}

async function handleRunEvents(request: Request, world: World, runId: string): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json()) as {
      eventType: string;
      eventData?: Record<string, unknown>;
      correlationId?: string;
    };
    const result = await world.events.create(runId, body as never);
    return Response.json({ eventId: result.event?.eventId, eventType: result.event?.eventType });
  }
  const result = await world.events.list({ runId, resolveData: "none" });
  return Response.json({
    data: result.data.map((e) => ({ eventId: e.eventId, eventType: e.eventType, runId: e.runId })),
  });
}

async function writeStreamChunks(
  world: World,
  streamName: string,
  runId: string,
  chunks: string[],
  close?: boolean,
): Promise<void> {
  for (const chunk of chunks) await world.writeToStream(streamName, runId, chunk);
  if (close) await world.closeStream(streamName, runId);
}

async function handleRunStream(request: Request, world: World, runId: string, streamName: string): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json()) as { chunks: string[]; close?: boolean };
    await writeStreamChunks(world, streamName, runId, body.chunks, body.close);
    return Response.json({ ok: true });
  }
  const readable = await world.readFromStream(streamName);
  return new Response(readable, { headers: { "content-type": "application/octet-stream" } });
}

async function handleStreamList(world: World, runId: string): Promise<Response> {
  const streams = await world.listStreamsByRunId(runId);
  return Response.json({ streams });
}

async function handleRunsRoute(request: Request, world: World): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/runs") return handleRunsRoot(request, world);

  const runParams = matchCapture(path, /^\/runs\/([^/]+)$/);
  if (runParams) return handleSingleRun(request, world, runParams[0] ?? "");

  const eventsParams = matchCapture(path, /^\/runs\/([^/]+)\/events$/);
  if (eventsParams) return handleRunEvents(request, world, eventsParams[0] ?? "");

  const streamParams = matchCapture(path, /^\/runs\/([^/]+)\/streams\/([^/]+)$/);
  if (streamParams) return handleRunStream(request, world, streamParams[0] ?? "", streamParams[1] ?? "");

  const streamsParams = matchCapture(path, /^\/runs\/([^/]+)\/streams$/);
  if (streamsParams) return handleStreamList(world, streamsParams[0] ?? "");

  return Response.json({ error: "Not Found" }, { status: 404 });
}

// --- /test route handlers ---

async function handleVmPolyfill(_request: Request): Promise<Response> {
  const mockWorkflowFn = async (...args: unknown[]) => ({ sum: (args[0] as number) + (args[1] as number) });
  const gMap = new Map<string, (...args: unknown[]) => unknown>();
  gMap.set("workflow//test//myWorkflow", mockWorkflowFn);
  (globalThis as Record<string, unknown>).__workflow_cloudflare_functions = gMap;

  const ctx = createContext({});
  const ctxResult = runInContext("globalThis", ctx);
  const wrappedFn = runInContext(
    `some code; globalThis.__private_workflows?.get("workflow//test//myWorkflow")`,
    ctx,
  ) as (...args: unknown[]) => Promise<unknown>;
  const result = await wrappedFn(3, 4);

  let unrecognizedThrew = false;
  try {
    runInContext("some random code", ctx);
  } catch {
    unrecognizedThrew = true;
  }
  let missingThrew = false;
  try {
    runInContext(`code; globalThis.__private_workflows?.get("nonexistent")`, ctx);
  } catch {
    missingThrew = true;
  }

  delete (globalThis as Record<string, unknown>).__workflow_cloudflare_functions;
  return Response.json({
    contextReturned: ctxResult === ctx,
    workflowResult: result,
    mathRandomStillWorks: typeof Math.random === "function",
    dateNowStillWorks: typeof Date.now === "function",
    unrecognizedThrew,
    missingThrew,
  });
}

async function handleCbor(request: Request): Promise<Response> {
  const body = (await request.json()) as { data: unknown };
  const encoder = new Encoder();
  const decoder = new Decoder();
  const encoded = encoder.encode(body.data);
  const testCases = [
    { input: "hello", label: "string" },
    { input: 42, label: "number" },
    { input: true, label: "boolean" },
    { input: [1, 2, 3], label: "array" },
    { input: { key: "value", nested: { a: 1 } }, label: "object" },
    { input: null, label: "null" },
  ];
  const results = testCases.map(({ input, label }) => {
    const enc = encoder.encode(input);
    return { label, roundTripped: JSON.stringify(decoder.decode(enc)) === JSON.stringify(input) };
  });
  return Response.json({
    encodedSize: encoded.byteLength,
    roundTripped: JSON.stringify(decoder.decode(encoded)) === JSON.stringify(body.data),
    allPassed: results.every((r) => r.roundTripped),
    results,
  });
}

async function handleQueueReenqueue(request: Request): Promise<Response> {
  const body = (await request.json()) as { timeoutSeconds: number };
  const sentMessages: Array<{ body: unknown; opts: unknown }> = [];
  const mockQueue: Pick<globalThis.Queue, "send"> = {
    send: async (msgBody: unknown, opts: unknown) => {
      sentMessages.push({ body: msgBody, opts });
    },
  };
  const { processQueueBatch } = await import("../../../src/queue-consumer.js");
  const mockMsg: Message = {
    body: {
      queueName: "__wkf_workflow_test",
      messageId: "msg_test123",
      body: Array.from(new TextEncoder().encode('{"test":true}')),
      attempt: 1,
      originalDelaySeconds: body.timeoutSeconds,
    },
    ack: () => {},
    retry: () => {},
    id: "test-id",
    timestamp: new Date(),
    attempts: 1,
  };
  const mockBatch: MessageBatch = {
    messages: [mockMsg],
    queue: "workflow-runs",
    ackAll: () => {},
    retryAll: () => {},
  };
  await processQueueBatch(
    mockBatch,
    {
      flow: async () => Response.json({ timeoutSeconds: body.timeoutSeconds }),
      step: async () => Response.json({ timeoutSeconds: body.timeoutSeconds }),
    },
    { WORKFLOW_QUEUE: mockQueue, WORKFLOW_STEP_QUEUE: mockQueue },
  );
  const reenqueued = sentMessages[0];
  const reenqueuedDelay = reenqueued ? (reenqueued.opts as { delaySeconds: number })?.delaySeconds : null;
  return Response.json({
    wasReenqueued: sentMessages.length > 0,
    requestedTimeout: body.timeoutSeconds,
    effectiveDelay: reenqueuedDelay,
    wasClamped: reenqueuedDelay !== null && reenqueuedDelay < body.timeoutSeconds,
    attemptIncremented: reenqueued ? (reenqueued.body as { attempt: number }).attempt === 2 : false,
  });
}

async function handleStreamDisconnect(request: Request, world: World): Promise<Response> {
  const body = (await request.json()) as { runId: string; streamName: string; chunkCount: number };
  for (let i = 0; i < body.chunkCount; i++) await world.writeToStream(body.streamName, body.runId, `chunk-${i} `);
  const readable = await world.readFromStream(body.streamName);
  const reader = readable.getReader();
  let chunksRead = 0;
  const readChunks: string[] = [];
  const { value, done } = await reader.read();
  if (!done && value) {
    chunksRead++;
    readChunks.push(new TextDecoder().decode(value));
  }
  await reader.cancel();
  await world.closeStream(body.streamName, body.runId);
  return Response.json({ chunksRead, readChunks, readerCancelled: true, totalWritten: body.chunkCount });
}

function handleEnvScoping(): Response {
  const cfEnv = getCloudflareEnv<Record<string, unknown>>();
  return Response.json({ hasDb: BINDING_NAMES.D1_DATABASE in cfEnv, bindingName: BINDING_NAMES.D1_DATABASE });
}

async function handleEnvOutsideContext(): Promise<Response> {
  const result = await new Promise<{ threw: boolean; message?: string }>((resolve) => {
    try {
      getCloudflareEnv();
      resolve({ threw: false });
    } catch (e) {
      resolve({ threw: true, message: (e as Error).message });
    }
  });
  return Response.json({ insideContext: !result.threw });
}

async function handleQueueDelay(request: Request, env: Record<string, unknown>): Promise<Response> {
  const body = (await request.json()) as { delaySeconds: number };
  const cfQueue = env[BINDING_NAMES.WORKFLOW_QUEUE] as globalThis.Queue;
  const effectiveDelay = Math.min(body.delaySeconds, 86_400);
  await cfQueue.send({ test: true, requestedDelay: body.delaySeconds }, { delaySeconds: effectiveDelay });
  return Response.json({
    requestedDelay: body.delaySeconds,
    effectiveDelay,
    maxDelay: 86_400,
    wasClamped: body.delaySeconds > 86_400,
  });
}

async function handleStreamOpenRead(request: Request, world: World): Promise<Response> {
  const body = (await request.json()) as { runId: string; streamName: string; chunks: string[] };
  for (const chunk of body.chunks) await world.writeToStream(body.streamName, body.runId, chunk);
  return Response.json({ written: body.chunks.length });
}

async function handleTestRoute(request: Request, env: Record<string, unknown>, world: World): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/test/vm-polyfill") return handleVmPolyfill(request);
  if (path === "/test/cbor") return handleCbor(request);
  if (path === "/test/queue-reenqueue") return handleQueueReenqueue(request);
  if (path === "/test/stream-disconnect") return handleStreamDisconnect(request, world);
  if (path === "/test/env-scoping") return handleEnvScoping();
  if (path === "/test/env-outside-context") return handleEnvOutsideContext();
  if (path === "/test/queue-delay") return handleQueueDelay(request, env);
  if (path === "/test/stream-open-read") return handleStreamOpenRead(request, world);
  return Response.json({ error: "Not Found" }, { status: 404 });
}

async function handleE2eFetch(request: Request, env: Record<string, unknown>, world: World): Promise<Response> {
  const path = new URL(request.url).pathname;
  try {
    if (path === "/health") return Response.json({ ok: true });
    if (path.startsWith("/runs")) return handleRunsRoute(request, world);
    if (path.startsWith("/test")) return handleTestRoute(request, env, world);
    return Response.json({ error: "Not Found" }, { status: 404 });
  } catch (err) {
    return Response.json({ error: String(err), stack: (err as Error).stack }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    const world = await createCloudflareWorld(env);
    return executionContextStorage.run(ctx, () => envStorage.run(env, () => handleE2eFetch(request, env, world)));
  },
};
