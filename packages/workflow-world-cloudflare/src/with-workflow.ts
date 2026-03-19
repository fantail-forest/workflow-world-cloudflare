/**
 * User-facing wrapper that integrates workflow capabilities into a
 * Cloudflare Worker. Accepts anything with a fetch() method (raw Worker,
 * Hono app, Itty Router, etc.) and returns a Worker export with the
 * proxy world and env storage configured.
 *
 * @example
 * ```ts
 * import { withWorkflow } from "workflow-world-cloudflare";
 * import { start } from "workflow/api";
 * import { onboardUser } from "#workflows";
 *
 * export default withWorkflow({
 *   async fetch(request, env, ctx) {
 *     const run = await start(onboardUser, [{ email: "alice@example.com" }]);
 *     return Response.json({ runId: run.runId });
 *   },
 * });
 * ```
 */

import { setWorld } from "@workflow/core/runtime";
import { envStorage } from "./env-storage.js";
import { executionContextStorage } from "./polyfills/vercel-functions.js";
import { createProxyWorld, type WorkflowServiceRPC } from "./proxy-world.js";

interface WorkerLike {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface WithWorkflowOptions {
  /** Name of the Service Binding to the workflow service worker. Defaults to "WORKFLOW". */
  binding?: string;
}

export function withWorkflow<T extends WorkerLike>(worker: T, options?: WithWorkflowOptions): T {
  const bindingName = options?.binding ?? "WORKFLOW";

  return {
    ...worker,
    async fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
      const service = env[bindingName] as unknown as WorkflowServiceRPC | undefined;
      if (!service) {
        throw new Error(
          `Missing "${bindingName}" Service Binding. ` +
            "Add a [[services]] block to your wrangler.toml pointing to the workflow service worker.",
        );
      }

      const world = createProxyWorld(service);
      setWorld(world);

      return executionContextStorage.run(ctx, () => envStorage.run(env, () => worker.fetch(request, env, ctx)));
    },
  } as T;
}
