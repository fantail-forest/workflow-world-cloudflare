import type { World } from "@workflow/world";
import { BINDING_NAMES } from "./config.js";
import { envStorage } from "./env-storage.js";
import { createCloudflareWorld } from "./index.js";
import { handleInspectRequest, type InspectRunDONamespace } from "./inspect-routes.js";
import { executionContextStorage } from "./polyfills/vercel-functions.js";
import { processQueueBatch } from "./queue-consumer.js";

export interface WorkerHandlersConfig {
  /**
   * The `setWorld` function from `@workflow/core`.
   * Must be passed in since `@workflow/core` is not a dependency of this package.
   */
  setWorld: (world: World) => void;

  /**
   * Flow (workflow) request handler -- the compiled flow-handler.js POST export.
   */
  flow: (req: Request) => Promise<Response>;

  /**
   * Step request handler -- the compiled step-handler.js POST export.
   */
  step: (req: Request) => Promise<Response>;

  /**
   * Optional webhook handler -- the compiled webhook-handler.js POST export.
   */
  webhook?: (req: Request) => Promise<Response>;

  /**
   * Optional manifest object to serve at /.well-known/workflow/v1/manifest.json.
   */
  manifest?: Record<string, unknown>;

  /**
   * Optional deployment ID for the world instance.
   */
  deploymentId?: string;

  /**
   * Optional callback for requests that don't match any workflow route.
   * If not provided, unmatched requests return 404.
   */
  onUnmatched?: (request: Request, env: Record<string, unknown>, world: World) => Promise<Response> | Response;
}

/**
 * Create pre-wired Worker `fetch` and `queue` handlers for a Cloudflare Worker.
 *
 * Encapsulates the boilerplate of setting up the world, wrapping requests in
 * AsyncLocalStorage contexts, routing to flow/step/webhook handlers, and
 * processing queue batches.
 *
 * @example
 * ```ts
 * import { setWorld } from '@workflow/core';
 * import { createWorkerHandlers } from 'workflow-world-cloudflare';
 * import flow from './workflow/flow-handler.js';
 * import step from './workflow/step-handler.js';
 *
 * const handlers = createWorkerHandlers({
 *   setWorld,
 *   flow: flow.POST,
 *   step: step.POST,
 * });
 *
 * export default handlers;
 * ```
 */
async function routeFetch(
  request: Request,
  env: Record<string, unknown>,
  world: World,
  config: WorkerHandlersConfig,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/.well-known/workflow/v1/flow")) return config.flow(request);
  if (path.startsWith("/.well-known/workflow/v1/step")) return config.step(request);
  if (config.webhook && path.startsWith("/.well-known/workflow/v1/webhook")) return config.webhook(request);
  if (config.manifest && path === "/.well-known/workflow/v1/manifest.json") return Response.json(config.manifest);
  if (path.startsWith("/.well-known/workflow/v1/inspect")) {
    const inspectToken = env.WORKFLOW_INSPECT_TOKEN as string | undefined;
    const runDO = env[BINDING_NAMES.RUN_DO] as InspectRunDONamespace | undefined;
    const inspectResponse = await handleInspectRequest(request, world, inspectToken, runDO);
    if (inspectResponse) return inspectResponse;
  }
  if (config.onUnmatched) return config.onUnmatched(request, env, world);
  return new Response("Not Found", { status: 404 });
}

export function createWorkerHandlers(config: WorkerHandlersConfig): {
  fetch: ExportedHandlerFetchHandler<Record<string, unknown>>;
  queue: ExportedHandlerQueueHandler<Record<string, unknown>>;
} {
  let cachedWorld: World | null = null;

  async function getWorld(env: Record<string, unknown>): Promise<World> {
    if (!cachedWorld) {
      cachedWorld = await createCloudflareWorld(env, { deploymentId: config.deploymentId });
      config.setWorld(cachedWorld);
    }
    return cachedWorld;
  }

  return {
    async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
      const world = await getWorld(env);
      return executionContextStorage.run(ctx, () => envStorage.run(env, () => routeFetch(request, env, world, config)));
    },

    async queue(batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext): Promise<void> {
      await getWorld(env);

      return executionContextStorage.run(ctx, () =>
        envStorage.run(env, async () => {
          await processQueueBatch(
            batch,
            { flow: config.flow, step: config.step },
            {
              WORKFLOW_QUEUE: env[BINDING_NAMES.WORKFLOW_QUEUE] as globalThis.Queue,
              WORKFLOW_STEP_QUEUE: env[BINDING_NAMES.STEP_QUEUE] as globalThis.Queue,
            },
          );
        }),
      );
    },
  };
}
