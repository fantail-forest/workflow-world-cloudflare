import { AsyncLocalStorage } from "node:async_hooks";

// Use a global singleton so the same AsyncLocalStorage instance is shared
// across separately-bundled handler files (_worker.js, step-handler.js, etc.)
const ENV_STORAGE_KEY = Symbol.for("workflow-cloudflare:envStorage");
const g = globalThis as Record<symbol, unknown>;
if (!g[ENV_STORAGE_KEY]) {
  g[ENV_STORAGE_KEY] = new AsyncLocalStorage<Record<string, unknown>>();
}
export const envStorage = g[ENV_STORAGE_KEY] as AsyncLocalStorage<Record<string, unknown>>;

/**
 * Access Cloudflare Worker environment bindings from within a step function.
 *
 * Only callable inside step functions running on the Cloudflare target.
 * Throws if called from a workflow function (sandboxed, no I/O) or
 * at module-level scope (no request context).
 *
 * @example
 * ```ts
 * async function queryDatabase(sql: string) {
 *   "use step"
 *   const env = getCloudflareEnv<Env>();
 *   const db = postgres(env.APP_DB.connectionString);
 *   return await db.unsafe(sql);
 * }
 * ```
 */
export function getCloudflareEnv<T = Record<string, unknown>>(): T {
  const store = envStorage.getStore();
  if (!store) {
    throw new Error(
      "`getCloudflareEnv()` can only be called inside a step function " + "running on the Cloudflare target.",
    );
  }
  return store as T;
}
