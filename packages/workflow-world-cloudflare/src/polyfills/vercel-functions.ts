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

export const executionContextStorage = new AsyncLocalStorage<CloudflareExecutionContext>();

export function waitUntil(promise: Promise<unknown>): void {
  const ctx = executionContextStorage.getStore();
  if (ctx) {
    ctx.waitUntil(promise);
  }
  // If no context (e.g. during tests), the promise runs fire-and-forget.
}
