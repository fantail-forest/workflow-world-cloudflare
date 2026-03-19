/**
 * D1 global index read/write helpers.
 *
 * The RunDO is the source of truth. D1 is a materialized projection for
 * cross-run queries (listing runs, looking up hooks by token, etc.).
 */

import type { WorkflowRun } from "@workflow/world";
import type { D1IndexSync } from "./run-do-storage.js";

export function createD1IndexSync(db: D1Database): D1IndexSync {
  return {
    async syncRun(run: WorkflowRun): Promise<void> {
      await db
        .prepare(
          `INSERT INTO workflow_runs_index (runId, status, workflowName, deploymentId, createdAt, updatedAt, startedAt, completedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(runId) DO UPDATE SET
             status = excluded.status,
             updatedAt = excluded.updatedAt,
             startedAt = COALESCE(excluded.startedAt, workflow_runs_index.startedAt),
             completedAt = COALESCE(excluded.completedAt, workflow_runs_index.completedAt)`,
        )
        .bind(
          run.runId,
          run.status,
          run.workflowName,
          run.deploymentId,
          run.createdAt.toISOString(),
          run.updatedAt.toISOString(),
          run.startedAt?.toISOString() ?? null,
          run.completedAt?.toISOString() ?? null,
        )
        .run();
    },

    async syncEvent(eventId: string, correlationId: string | undefined, runId: string): Promise<void> {
      await db
        .prepare("INSERT OR IGNORE INTO workflow_events_index (eventId, correlationId, runId) VALUES (?, ?, ?)")
        .bind(eventId, correlationId ?? null, runId)
        .run();
    },

    async syncStep(stepId: string, runId: string): Promise<void> {
      await db
        .prepare("INSERT OR IGNORE INTO workflow_steps_index (stepId, runId) VALUES (?, ?)")
        .bind(stepId, runId)
        .run();
    },

    async syncHookCreated(hookId: string, token: string, runId: string): Promise<void> {
      await db
        .prepare("INSERT OR IGNORE INTO workflow_hooks_index (hookId, token, runId) VALUES (?, ?, ?)")
        .bind(hookId, token, runId)
        .run();
    },

    async syncHookDeleted(runId: string): Promise<void> {
      await db.prepare("DELETE FROM workflow_hooks_index WHERE runId = ?").bind(runId).run();
    },

    async checkTokenUniqueness(token: string): Promise<boolean> {
      const result = await db
        .prepare("SELECT hookId FROM workflow_hooks_index WHERE token = ? LIMIT 1")
        .bind(token)
        .first<{ hookId: string }>();
      return result === null;
    },
  };
}

// D1 query helpers for cross-run reads

export async function d1ListRuns(
  db: D1Database,
  params?: {
    workflowName?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  },
): Promise<{
  data: Array<{
    runId: string;
    status: string;
    workflowName: string;
    deploymentId: string;
  }>;
  cursor: string | null;
  hasMore: boolean;
}> {
  const limit = params?.limit ?? 20;
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (params?.workflowName) {
    conditions.push("workflowName = ?");
    binds.push(params.workflowName);
  }
  if (params?.status) {
    conditions.push("status = ?");
    binds.push(params.status);
  }
  if (params?.cursor) {
    conditions.push("runId < ?");
    binds.push(params.cursor);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  binds.push(limit + 1);

  const result = await db
    .prepare(
      `SELECT runId, status, workflowName, deploymentId FROM workflow_runs_index ${where} ORDER BY runId DESC LIMIT ?`,
    )
    .bind(...binds)
    .all<{
      runId: string;
      status: string;
      workflowName: string;
      deploymentId: string;
    }>();

  const values = result.results.slice(0, limit);
  return {
    data: values,
    cursor: values.at(-1)?.runId ?? null,
    hasMore: result.results.length > limit,
  };
}

export async function d1GetRunIdByHookToken(
  db: D1Database,
  token: string,
): Promise<{ hookId: string; runId: string } | null> {
  return await db
    .prepare("SELECT hookId, runId FROM workflow_hooks_index WHERE token = ? LIMIT 1")
    .bind(token)
    .first<{ hookId: string; runId: string }>();
}

export async function d1GetRunIdByStepId(db: D1Database, stepId: string): Promise<string | null> {
  const result = await db
    .prepare("SELECT runId FROM workflow_steps_index WHERE stepId = ? LIMIT 1")
    .bind(stepId)
    .first<{ runId: string }>();
  return result?.runId ?? null;
}
