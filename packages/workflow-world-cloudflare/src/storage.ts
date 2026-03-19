/**
 * Storage implementation routing requests to RunDO (per-run state) and D1 (cross-run queries).
 *
 * - Write operations (events.create) go through RunDO for serialization
 * - Per-run reads (run.get, step.get, event.get) go through RunDO
 * - Cross-run reads (runs.list) go through D1 index + RunDO for full data
 */

import type {
  Event,
  EventResult,
  GetEventParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  PaginatedResponse,
  Step,
  StepWithoutData,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from "@workflow/world";
import { stripEventDataRefs } from "@workflow/world";
import type { CloudflareWorldConfig } from "./config.js";
import { d1GetRunIdByHookToken, d1GetRunIdByStepId, d1ListRuns } from "./d1-index.js";
import type { WorkflowRunDO } from "./run-do.js";

type RunDOStub = DurableObjectStub & WorkflowRunDO;

function getRunDOStub(config: CloudflareWorldConfig, runId: string): RunDOStub {
  const id = config.runDO.idFromName(runId);
  return config.runDO.get(id) as RunDOStub;
}

function filterRunData(run: WorkflowRun, resolveData: "none" | "all"): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = run;
    return {
      input: undefined,
      output: undefined,
      ...rest,
    } as WorkflowRunWithoutData;
  }
  return run;
}

function filterStepData(step: Step, resolveData: "none" | "all"): Step | StepWithoutData {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest } as StepWithoutData;
  }
  return step;
}

function filterHookData(hook: Hook, resolveData: "none" | "all"): Hook {
  if (resolveData === "none" && "metadata" in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest } as Hook;
  }
  return hook;
}

export function createStorage(config: CloudflareWorldConfig): Storage {
  return {
    runs: {
      get: (async (id: string, params?: { resolveData?: "none" | "all" }) => {
        const stub = getRunDOStub(config, id);
        const run = await stub.getRun(id);
        if (!run) {
          throw new Error(`Run not found: ${id}`);
        }
        const resolveData = params?.resolveData ?? "all";
        return filterRunData(run, resolveData);
      }) as Storage["runs"]["get"],

      list: (async (params?: {
        workflowName?: string;
        status?: string;
        pagination?: { limit?: number; cursor?: string };
        resolveData?: "none" | "all";
      }) => {
        const resolveData = params?.resolveData ?? "all";

        // Use D1 for cross-run listing
        const d1Result = await d1ListRuns(config.db, {
          workflowName: params?.workflowName,
          status: params?.status,
          limit: params?.pagination?.limit,
          cursor: params?.pagination?.cursor,
        });

        if (resolveData === "none") {
          // D1 index has enough data for no-data responses
          return {
            data: d1Result.data.map((r) => ({
              runId: r.runId,
              status: r.status,
              workflowName: r.workflowName,
              deploymentId: r.deploymentId,
              input: undefined,
              output: undefined,
              createdAt: new Date(),
              updatedAt: new Date(),
            })),
            cursor: d1Result.cursor,
            hasMore: d1Result.hasMore,
          };
        }

        // For full data, fetch each run from its RunDO
        const runs = await Promise.all(
          d1Result.data.map(async (r) => {
            const stub = getRunDOStub(config, r.runId);
            const run = await stub.getRun(r.runId);
            return run;
          }),
        );

        return {
          data: runs.filter(Boolean) as WorkflowRun[],
          cursor: d1Result.cursor,
          hasMore: d1Result.hasMore,
        };
      }) as Storage["runs"]["list"],
    },

    steps: {
      get: (async (runId: string | undefined, stepId: string, params?: { resolveData?: "none" | "all" }) => {
        let effectiveRunId = runId;
        if (!effectiveRunId) {
          effectiveRunId = (await d1GetRunIdByStepId(config.db, stepId)) ?? undefined;
        }
        if (!effectiveRunId) {
          throw new Error(`Step not found: ${stepId}`);
        }
        const stub = getRunDOStub(config, effectiveRunId);
        const step = await stub.getStep(stepId, effectiveRunId);
        if (!step) {
          throw new Error(`Step not found: ${stepId}`);
        }
        const resolveData = params?.resolveData ?? "all";
        return filterStepData(step, resolveData);
      }) as Storage["steps"]["get"],

      list: (async (params: {
        runId: string;
        pagination?: {
          limit?: number;
          cursor?: string;
          sortOrder?: "asc" | "desc";
        };
        resolveData?: "none" | "all";
      }) => {
        const stub = getRunDOStub(config, params.runId);
        const result = await stub.listSteps(
          params.runId,
          params.pagination?.limit ?? 20,
          params.pagination?.cursor,
          params.pagination?.sortOrder,
        );
        const resolveData = params?.resolveData ?? "all";
        return {
          data: result.data.map((s) => filterStepData(s, resolveData)),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      }) as Storage["steps"]["list"],
    },

    events: {
      async create(runId, data, params): Promise<EventResult> {
        let effectiveRunId: string = runId ?? "";
        if (
          (data as Record<string, unknown>).eventType === "run_created" &&
          (!effectiveRunId || effectiveRunId === "")
        ) {
          const { monotonicFactory } = await import("ulid");
          const ulid = monotonicFactory();
          effectiveRunId = `wrun_${ulid()}`;
        }

        if (!effectiveRunId) {
          throw new Error("runId is required for event creation");
        }

        const stub = getRunDOStub(config, effectiveRunId);
        return await stub.createEvent(effectiveRunId, data as Record<string, unknown>, params);
      },

      async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
        const stub = getRunDOStub(config, runId);
        const event = await stub.getEvent(eventId, runId);
        if (!event) {
          throw new Error(`Event not found: ${eventId}`);
        }
        const resolveData = params?.resolveData ?? "all";
        return stripEventDataRefs(event, resolveData);
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        const stub = getRunDOStub(config, params.runId);
        const result = await stub.listEvents(
          params.runId,
          params.pagination?.limit ?? 100,
          params.pagination?.cursor,
          params.pagination?.sortOrder ?? "asc",
        );
        const resolveData = params?.resolveData ?? "all";
        return {
          data: result.data.map((e) => stripEventDataRefs(e, resolveData)),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      },

      async listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<PaginatedResponse<Event>> {
        // Need to find which run this correlation belongs to via D1
        const result = await config.db
          .prepare("SELECT runId FROM workflow_events_index WHERE correlationId = ? LIMIT 1")
          .bind(params.correlationId)
          .first<{ runId: string }>();

        if (!result) {
          return { data: [], cursor: null, hasMore: false };
        }

        const stub = getRunDOStub(config, result.runId);
        const events = await stub.listEventsByCorrelationId(
          params.correlationId,
          result.runId,
          params.pagination?.limit ?? 100,
          params.pagination?.cursor,
          params.pagination?.sortOrder ?? "asc",
        );
        const resolveData = params?.resolveData ?? "all";
        return {
          data: events.data.map((e) => stripEventDataRefs(e, resolveData)),
          cursor: events.cursor,
          hasMore: events.hasMore,
        };
      },
    },

    hooks: {
      async get(hookId: string, params?) {
        // Look up runId from D1 index
        const result = await config.db
          .prepare("SELECT runId FROM workflow_hooks_index WHERE hookId = ? LIMIT 1")
          .bind(hookId)
          .first<{ runId: string }>();
        if (!result) {
          throw new Error(`Hook not found: ${hookId}`);
        }
        const stub = getRunDOStub(config, result.runId);
        const hook = await stub.getHook(hookId, result.runId);
        if (!hook) {
          throw new Error(`Hook not found: ${hookId}`);
        }
        const resolveData = params?.resolveData ?? "all";
        return filterHookData(hook, resolveData);
      },

      async getByToken(token: string, params?) {
        const result = await d1GetRunIdByHookToken(config.db, token);
        if (!result) {
          throw new Error("Hook not found for token");
        }
        const stub = getRunDOStub(config, result.runId);
        const hook = await stub.getHook(result.hookId, result.runId);
        if (!hook) {
          throw new Error("Hook not found for token");
        }
        const resolveData = params?.resolveData ?? "all";
        return filterHookData(hook, resolveData);
      },

      async list(params: ListHooksParams) {
        if (params.runId) {
          const stub = getRunDOStub(config, params.runId);
          const result = await stub.listHooks(
            params.runId,
            params.pagination?.limit ?? 100,
            params.pagination?.cursor,
            params.pagination?.sortOrder,
          );
          const resolveData = params?.resolveData ?? "all";
          return {
            data: result.data.map((h) => filterHookData(h, resolveData)),
            cursor: result.cursor,
            hasMore: result.hasMore,
          };
        }

        // List all hooks across runs via D1 index
        const limit = params.pagination?.limit ?? 100;
        const d1Result = await config.db
          .prepare(
            params.pagination?.cursor
              ? "SELECT hookId, runId FROM workflow_hooks_index WHERE hookId > ? ORDER BY hookId ASC LIMIT ?"
              : "SELECT hookId, runId FROM workflow_hooks_index ORDER BY hookId ASC LIMIT ?",
          )
          .bind(...(params.pagination?.cursor ? [params.pagination.cursor, limit + 1] : [limit + 1]))
          .all<{ hookId: string; runId: string }>();

        const values = d1Result.results.slice(0, limit);
        const hooks = await Promise.all(
          values.map(async (v) => {
            const stub = getRunDOStub(config, v.runId);
            return await stub.getHook(v.hookId, v.runId);
          }),
        );

        const resolveData = params?.resolveData ?? "all";
        return {
          data: hooks.filter((h): h is NonNullable<typeof h> => h != null).map((h) => filterHookData(h, resolveData)),
          cursor: values.at(-1)?.hookId ?? null,
          hasMore: d1Result.results.length > limit,
        };
      },
    },
  };
}
