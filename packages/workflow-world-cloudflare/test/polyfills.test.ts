import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "../src/polyfills/module.js";
import { executionContextStorage, waitUntil } from "../src/polyfills/vercel-functions.js";
import { createContext, runInContext } from "../src/polyfills/vm.js";

describe("vm polyfill", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__workflow_cloudflare_functions = new Map<
      string,
      (...args: unknown[]) => unknown
    >([
      [
        "testWorkflow",
        async function testWorkflow(input: unknown) {
          return {
            random: Math.random(),
            now: Date.now(),
            input,
          };
        },
      ],
    ]);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__workflow_cloudflare_functions;
  });

  describe("createContext", () => {
    it("returns an object with a copied Math", () => {
      const ctx = createContext();
      expect(ctx).toBeDefined();
      expect(ctx.Math).toBeDefined();
      expect(ctx.Math).not.toBe(Math);
    });

    it("uses provided sandbox", () => {
      const sandbox = { foo: "bar" };
      const ctx = createContext(sandbox);
      expect(ctx.foo).toBe("bar");
    });

    it("creates independent Math copy", () => {
      const ctx = createContext();
      const mathObj = ctx.Math as typeof Math;
      const originalRandom = Math.random;
      mathObj.random = () => 0.42;
      expect(Math.random).toBe(originalRandom);
    });
  });

  describe("runInContext", () => {
    it("handles globalThis pattern", () => {
      const ctx = { foo: "bar" };
      const result = runInContext("globalThis", ctx);
      expect(result).toBe(ctx);
    });

    it("handles globalThis with whitespace", () => {
      const ctx = { test: true };
      const result = runInContext("  globalThis  ", ctx);
      expect(result).toBe(ctx);
    });

    it("looks up workflow function by name", async () => {
      const ctx = createContext();
      const code = 'some workflow code; globalThis.__private_workflows?.get("testWorkflow")';
      const fn = runInContext(code, ctx);
      expect(typeof fn).toBe("function");

      const result = await (fn as (...args: unknown[]) => Promise<{ input: unknown }>)({ value: 42 });
      expect(result.input).toEqual({ value: 42 });
    });

    it("throws for unknown workflow name", () => {
      const ctx = createContext();
      const code = 'code; globalThis.__private_workflows?.get("nonexistent")';
      expect(() => runInContext(code, ctx)).toThrow('Workflow "nonexistent" not found');
    });

    it("throws for unrecognized code pattern", () => {
      const ctx = createContext();
      expect(() => runInContext("random code", ctx)).toThrow("unrecognized code pattern");
    });

    it("temporarily overrides globals during execution", async () => {
      const originalMathRandom = Math.random;
      const deterministicRandom = () => 0.123;

      const ctx = createContext();
      ctx.Math = { ...Math, random: deterministicRandom };

      const code = 'code; globalThis.__private_workflows?.get("testWorkflow")';
      const fn = runInContext(code, ctx);

      // During execution, Math.random should be overridden
      const result = await (fn as (...args: unknown[]) => Promise<{ random: number }>)("test");
      expect(result.random).toBe(0.123);

      // After execution, Math.random should be restored
      expect(Math.random).toBe(originalMathRandom);
    });

    it("restores globals even if workflow throws", async () => {
      const originalMathRandom = Math.random;

      (globalThis as Record<string, unknown>).__workflow_cloudflare_functions = new Map<
        string,
        (...args: unknown[]) => unknown
      >([
        [
          "throwingWorkflow",
          async () => {
            throw new Error("workflow error");
          },
        ],
      ]);

      const ctx = createContext();
      ctx.Math = { ...Math, random: () => 0.999 };

      const code = 'code; globalThis.__private_workflows?.get("throwingWorkflow")';
      const fn = runInContext(code, ctx);

      await expect((fn as () => Promise<unknown>)()).rejects.toThrow("workflow error");
      expect(Math.random).toBe(originalMathRandom);
    });
  });
});

describe("module polyfill", () => {
  it("createRequire returns a function", () => {
    const require = createRequire();
    expect(typeof require).toBe("function");
  });

  it("require throws with helpful message", () => {
    const require = createRequire();
    // biome-ignore lint/correctness/noUndeclaredDependencies: intentionally testing with a fake module name
    expect(() => require("some-module")).toThrow('Dynamic require("some-module") is not supported');
  });
});

describe("vercel-functions polyfill", () => {
  it("waitUntil delegates to ctx.waitUntil when store exists", () => {
    const calls: Promise<unknown>[] = [];
    const mockCtx = {
      waitUntil: (p: Promise<unknown>) => calls.push(p),
      passThroughOnException: () => {},
    };

    const testPromise = Promise.resolve("done");
    executionContextStorage.run(mockCtx, () => {
      waitUntil(testPromise);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(testPromise);
  });

  it("waitUntil is a no-op without store", () => {
    // Should not throw
    waitUntil(Promise.resolve());
  });
});
