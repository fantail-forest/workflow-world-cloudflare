import { describe, expect, it } from "vitest";
import { envStorage, getCloudflareEnv } from "../src/env-storage.js";

describe("env-storage", () => {
  it("getCloudflareEnv returns env from ALS store", () => {
    const env = { MY_KV: "kv-binding", MY_DB: "db-binding" };
    envStorage.run(env, () => {
      const result = getCloudflareEnv<typeof env>();
      expect(result.MY_KV).toBe("kv-binding");
      expect(result.MY_DB).toBe("db-binding");
    });
  });

  it("getCloudflareEnv throws outside of request context", () => {
    expect(() => getCloudflareEnv()).toThrow("can only be called inside a step function");
  });

  it("getCloudflareEnv supports typed access", () => {
    interface Env {
      APP_DB: { connectionString: string };
    }
    const env = { APP_DB: { connectionString: "postgres://..." } };
    envStorage.run(env, () => {
      const result = getCloudflareEnv<Env>();
      expect(result.APP_DB.connectionString).toBe("postgres://...");
    });
  });

  it("nested ALS contexts work correctly", () => {
    const outer = { ctx: "outer" };
    const inner = { ctx: "inner" };

    envStorage.run(outer, () => {
      expect(getCloudflareEnv<typeof outer>().ctx).toBe("outer");

      envStorage.run(inner, () => {
        expect(getCloudflareEnv<typeof inner>().ctx).toBe("inner");
      });

      expect(getCloudflareEnv<typeof outer>().ctx).toBe("outer");
    });
  });
});
