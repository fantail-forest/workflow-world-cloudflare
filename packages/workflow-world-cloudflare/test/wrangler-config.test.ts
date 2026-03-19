import { describe, expect, it } from "vitest";
import { deriveResourceNames } from "../src/builder.js";

describe("resource namespacing", () => {
  it("derives all resource names from appName", () => {
    const names = deriveResourceNames("billing");
    expect(names).toEqual({
      workerName: "billing",
      d1DatabaseName: "billing-workflow-db",
      runQueueName: "billing-workflow-runs",
      stepQueueName: "billing-workflow-steps",
    });
  });

  it("handles hyphenated app names", () => {
    const names = deriveResourceNames("team-a-billing");
    expect(names.d1DatabaseName).toBe("team-a-billing-workflow-db");
    expect(names.runQueueName).toBe("team-a-billing-workflow-runs");
    expect(names.stepQueueName).toBe("team-a-billing-workflow-steps");
  });

  it("different app names produce non-overlapping resources", () => {
    const a = deriveResourceNames("project-alpha");
    const b = deriveResourceNames("project-beta");

    expect(a.d1DatabaseName).not.toBe(b.d1DatabaseName);
    expect(a.runQueueName).not.toBe(b.runQueueName);
    expect(a.stepQueueName).not.toBe(b.stepQueueName);
    expect(a.workerName).not.toBe(b.workerName);
  });
});

function isMergeableObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function mergeValue(key: string, value: unknown, base: Record<string, unknown>): unknown {
  if (key === "compatibility_flags") {
    const baseFlags = (base[key] as string[] | undefined) ?? [];
    const overrideFlags = (value as string[] | undefined) ?? [];
    return [...new Set([...baseFlags, ...overrideFlags])];
  }
  if (Array.isArray(value) && Array.isArray(base[key])) {
    return [...(base[key] as unknown[]), ...value];
  }
  if (isMergeableObject(value) && isMergeableObject(base[key])) {
    return deepMerge(base[key], value);
  }
  return value;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = mergeValue(key, value, base);
  }
  return result;
}

describe("wrangler config merge", () => {
  it("scalars: override wins", () => {
    const result = deepMerge({ name: "base" }, { name: "override" });
    expect(result.name).toBe("override");
  });

  it("arrays: concatenated", () => {
    const result = deepMerge(
      {
        kv_namespaces: [{ binding: "A", id: "1" }],
      },
      {
        kv_namespaces: [{ binding: "B", id: "2" }],
      },
    );
    expect(result.kv_namespaces).toEqual([
      { binding: "A", id: "1" },
      { binding: "B", id: "2" },
    ]);
  });

  it("compatibility_flags: set union", () => {
    const result = deepMerge(
      { compatibility_flags: ["nodejs_compat"] },
      { compatibility_flags: ["nodejs_compat", "streams_enable_constructors"] },
    );
    expect(result.compatibility_flags).toEqual(["nodejs_compat", "streams_enable_constructors"]);
  });

  it("nested objects: deep merge", () => {
    const result = deepMerge(
      {
        durable_objects: {
          bindings: [{ name: "RUN_DO" }],
        },
      },
      {
        durable_objects: {
          bindings: [{ name: "CUSTOM_DO" }],
        },
      },
    );
    const doConfig = result.durable_objects as Record<string, unknown>;
    expect(doConfig.bindings).toEqual([{ name: "RUN_DO" }, { name: "CUSTOM_DO" }]);
  });

  it("new keys from override are added", () => {
    const result = deepMerge({ name: "app" }, { hyperdrive: [{ binding: "DB", id: "abc" }] });
    expect(result.name).toBe("app");
    expect(result.hyperdrive).toEqual([{ binding: "DB", id: "abc" }]);
  });
});
