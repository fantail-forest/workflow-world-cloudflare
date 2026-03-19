/**
 * Polyfill for `@vercel/functions` on Cloudflare Workers.
 *
 * Five files in core import `waitUntil` from `@vercel/functions`. This polyfill
 * stores the CF Worker's ExecutionContext via AsyncLocalStorage and delegates
 * to `ctx.waitUntil()`.
 *
 * The generated Worker entry point wraps handlers with:
 *   executionContextStorage.run(ctx, () => ...)
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const EXEC_CTX_KEY = Symbol.for("workflow-cloudflare:executionContextStorage");
const g = globalThis as Record<symbol, unknown>;
if (!g[EXEC_CTX_KEY]) {
  g[EXEC_CTX_KEY] = new AsyncLocalStorage<CloudflareExecutionContext>();
}
export const executionContextStorage = g[EXEC_CTX_KEY] as AsyncLocalStorage<CloudflareExecutionContext>;

export function waitUntil(promise: Promise<unknown>): void {
  const ctx = executionContextStorage.getStore();
  if (ctx) {
    ctx.waitUntil(promise);
  }
  // If no context (e.g. during tests), the promise runs fire-and-forget.
}
