import type { World } from "@workflow/world";
import { BINDING_NAMES, type CloudflareWorldConfig, D1_SCHEMA_STATEMENTS } from "./config.js";
import { createQueue } from "./queue.js";
import { createStorage } from "./storage.js";
import { createStreamer } from "./streamer.js";

export type { CloudflareWorldConfig } from "./config.js";
export {
  BINDING_NAMES,
  D1_SCHEMA_STATEMENTS,
  DO_CLASS_NAMES,
  QUEUE_NAMES,
} from "./config.js";
export { envStorage, getCloudflareEnv } from "./env-storage.js";
export { handleInspectRequest } from "./inspect-routes.js";
export { executionContextStorage } from "./polyfills/vercel-functions.js";
export { processQueueBatch } from "./queue-consumer.js";
export {
  createWorkerHandlers,
  type WorkerHandlersConfig,
} from "./worker-handlers.js";

let d1Migrated = false;

async function ensureD1Schema(db: D1Database): Promise<void> {
  if (d1Migrated) return;
  await db.batch(D1_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
  d1Migrated = true;
}

/**
 * Create a Cloudflare World instance from the Worker environment bindings.
 *
 * On first call, automatically creates the D1 index tables if they don't
 * already exist (all DDL uses IF NOT EXISTS, so this is idempotent).
 *
 * Typically called in the generated Worker entry point:
 * ```ts
 * setWorld(createCloudflareWorld(env));
 * ```
 */
export async function createCloudflareWorld(
  env: Record<string, unknown>,
  opts?: { deploymentId?: string },
): Promise<World> {
  const db = env[BINDING_NAMES.D1_DATABASE] as D1Database;
  await ensureD1Schema(db);

  const config: CloudflareWorldConfig = {
    db,
    runDO: env[BINDING_NAMES.RUN_DO] as DurableObjectNamespace,
    streamDO: env[BINDING_NAMES.STREAM_DO] as DurableObjectNamespace,
    workflowQueue: env[BINDING_NAMES.WORKFLOW_QUEUE] as globalThis.Queue,
    stepQueue: env[BINDING_NAMES.STEP_QUEUE] as globalThis.Queue,
    deploymentId: opts?.deploymentId,
  };

  const queue = createQueue(config);
  const storage = createStorage(config);
  const streamer = createStreamer(config.streamDO, config.db);

  return {
    ...storage,
    ...streamer,
    ...queue,
  };
}
