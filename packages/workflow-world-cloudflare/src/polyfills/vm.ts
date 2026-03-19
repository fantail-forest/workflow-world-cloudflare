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

  // Seed the context with all globals from globalThis so that vm/index.ts
  // can override Date, Math, crypto, Symbol, etc. with deterministic versions.
  // Math gets its own copy because vm/index.ts mutates Math.random in-place.
  for (const key of Object.getOwnPropertyNames(globalThis)) {
    if (key in ctx) continue;
    try {
      ctx[key] = (globalThis as Record<string, unknown>)[key];
    } catch {
      // Some properties may not be readable
    }
  }
  ctx.Math = Object.create(Object.getPrototypeOf(Math), Object.getOwnPropertyDescriptors(Math));

  return ctx;
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

  // Use the pre-compiled code factory injected by the CloudflareBuilder.
  // This factory executes the compiled workflow code (with step stubs bound
  // to the context's WORKFLOW_USE_STEP) and returns __private_workflows.
  const factory = (globalThis as Record<string, unknown>).__workflow_cloudflare_code_factory as
    | ((ctx: Record<string, unknown>) => Map<string, (...args: unknown[]) => unknown>)
    | undefined;

  if (!factory) {
    throw new Error(
      "runInContext polyfill: __workflow_cloudflare_code_factory not found. " +
        "Ensure the CloudflareBuilder patched the flow-handler.",
    );
  }

  const workflows = factory(context);
  const workflowFn = workflows?.get(workflowName);

  if (workflowFn == null) {
    throw new Error(
      `Workflow "${workflowName}" not found in pre-compiled code. ` +
        `Available: [${workflows ? [...workflows.keys()].join(", ") : "none"}]`,
    );
  }

  return workflowFn;
}
