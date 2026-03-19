/**
 * Polyfill for `node:vm` on Cloudflare Workers.
 *
 * Does NOT require `unsafe-eval`. Instead of evaluating the workflow code
 * string at runtime, the CloudflareBuilder pre-imports workflow functions
 * statically into a global Map. This polyfill looks them up by name.
 *
 * Two call patterns from packages/core are handled:
 *
 * 1. vm/index.ts: `runInContext('globalThis', context)` — returns the context
 *    object so vm/index.ts can set up deterministic overrides on it.
 *
 * 2. workflow.ts: `runInContext(`${workflowCode}; globalThis.__private_workflows?.get("name")`, context)`
 *    — extracts the workflow name via regex, looks up the pre-imported function,
 *    and returns an async wrapper that temporarily overrides globalThis properties.
 */

export function createContext(sandbox?: Record<string, unknown>) {
  const ctx: Record<string, unknown> = sandbox ?? {};

  // Math needs its own copy because vm/index.ts modifies Math.random in-place.
  // All other globals (Date, crypto, etc.) are replaced entirely by vm/index.ts
  // via assignment, so sharing the reference is safe.
  if (!("Math" in ctx)) {
    ctx.Math = Object.create(Object.getPrototypeOf(Math), Object.getOwnPropertyDescriptors(Math));
  }

  return ctx;
}

function snapshotGlobals(context: Record<string, unknown>): Map<string, { existed: boolean; value: unknown }> {
  const saved = new Map<string, { existed: boolean; value: unknown }>();
  for (const key of Object.getOwnPropertyNames(context)) {
    saved.set(key, { existed: key in globalThis, value: (globalThis as Record<string, unknown>)[key] });
  }
  return saved;
}

function applyGlobals(context: Record<string, unknown>): void {
  for (const key of Object.getOwnPropertyNames(context)) {
    try {
      (globalThis as Record<string, unknown>)[key] = context[key];
    } catch {
      // Some globals may be non-writable
    }
  }
}

function restoreGlobals(saved: Map<string, { existed: boolean; value: unknown }>): void {
  for (const [key, { existed, value }] of saved) {
    try {
      if (existed) {
        (globalThis as Record<string, unknown>)[key] = value;
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    } catch {
      // Some globals may be non-configurable
    }
  }
}

const WORKFLOW_NAME_RE = /__private_workflows\?\.get\(("(?:[^"\\]|\\.)*")\)/;

export function runInContext(code: string, context: Record<string, unknown>, _options?: unknown) {
  // Pattern 1: vm/index.ts calls runInContext('globalThis', context)
  if (code.trim() === "globalThis") {
    return context;
  }

  // Pattern 2: workflow.ts evaluates the workflow code string and retrieves
  // the workflow function by name.
  const match = code.match(WORKFLOW_NAME_RE);
  if (!match) {
    throw new Error(
      "runInContext polyfill: unrecognized code pattern. " +
        "Only the two call patterns from @workflow/core are supported.",
    );
  }
  const matchedName = match[1];
  if (matchedName === undefined) {
    throw new Error("runInContext polyfill: regex match group 1 is undefined");
  }
  const workflowName = JSON.parse(matchedName) as string;

  const fns = (globalThis as Record<string, unknown>).__workflow_cloudflare_functions as
    | Map<string, (...args: unknown[]) => unknown>
    | undefined;
  if (!fns?.has(workflowName)) {
    throw new Error(
      `Workflow "${workflowName}" not found in pre-imported functions. ` +
        "Ensure the CloudflareBuilder registered it in __workflow_cloudflare_functions.",
    );
  }
  const workflowFn = fns.get(workflowName);

  if (workflowFn == null) {
    throw new Error(
      `BUG: Workflow "${workflowName}" not found in pre-imported functions. ` +
        "Ensure the CloudflareBuilder registered it in __workflow_cloudflare_functions.",
    );
  }

  // Return a wrapper that temporarily overrides globals with the context's
  // deterministic versions during workflow execution.
  //
  // Safety: queue processing is sequential (one message at a time), globals
  // are restored in a finally block (even on WorkflowSuspension), and
  // JavaScript resolves global names at call time so the pre-imported function
  // sees the overridden Math/Date/crypto/fetch/etc.
  return async function wrappedWorkflow(...args: unknown[]) {
    const saved = snapshotGlobals(context);
    applyGlobals(context);
    try {
      return await workflowFn(...args);
    } finally {
      restoreGlobals(saved);
    }
  };
}
