import { AsyncLocalStorage } from "node:async_hooks";

export const envStorage = new AsyncLocalStorage<Record<string, unknown>>();

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
