import { DurableObject } from "cloudflare:workers";
import type { EventResult, ResolveData } from "@workflow/world";
import { BINDING_NAMES } from "./config.js";
import { createD1IndexSync } from "./d1-index.js";
import {
  type D1IndexSync,
  getEvent,
  getHook,
  getRun,
  getStep,
  listEvents,
  listEventsByCorrelationId,
  listHooks,
  listSteps,
  processEvent,
} from "./run-do-storage.js";

/**
 * One instance per workflow run. All writes for a run are serialized through
 * this DO's single-threaded execution model, replacing the need for
 * explicit transactions (as used in world-postgres).
 */
export class WorkflowRunDO extends DurableObject {
  private d1Sync: D1IndexSync;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    const db = env[BINDING_NAMES.D1_DATABASE] as D1Database;
    this.d1Sync = createD1IndexSync(db);

    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS run (
          runId TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          workflowName TEXT NOT NULL,
          deploymentId TEXT NOT NULL,
          specVersion INTEGER,
          input BLOB,
          output BLOB,
          error TEXT,
          executionContext TEXT,
          expiredAt TEXT,
          startedAt TEXT,
          completedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          eventId TEXT PRIMARY KEY,
          eventType TEXT NOT NULL,
          correlationId TEXT,
          eventData TEXT,
          specVersion INTEGER,
          createdAt TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_correlationId ON events(correlationId)
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS steps (
          stepId TEXT PRIMARY KEY,
          stepName TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          input BLOB,
          output BLOB,
          error TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          startedAt TEXT,
          completedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          retryAfter TEXT,
          specVersion INTEGER
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS hooks (
          hookId TEXT PRIMARY KEY,
          token TEXT UNIQUE NOT NULL,
          metadata BLOB,
          isWebhook INTEGER,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          specVersion INTEGER
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS waits (
          waitId TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'waiting',
          resumeAt TEXT,
          completedAt TEXT,
          createdAt TEXT NOT NULL DEFAULT (datetime('now')),
          updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
          specVersion INTEGER
        )
      `);

      // Determine runId from the run table if it exists
      const rows = this.ctx.storage.sql.exec<{ runId: string }>("SELECT runId FROM run LIMIT 1").toArray();
      if (rows[0]) {
        // runId is stored per-DO for potential future use
      }
    });
  }

  async createEvent(
    runId: string,
    data: Record<string, unknown>,
    params?: { resolveData?: ResolveData },
  ): Promise<EventResult> {
    return processEvent(this.ctx.storage.sql, runId, data, params, this.d1Sync);
  }

  async getRun(runId: string) {
    return getRun(this.ctx.storage.sql, runId);
  }

  async getStep(stepId: string, runId: string) {
    return getStep(this.ctx.storage.sql, stepId, runId);
  }

  async listSteps(runId: string, limit: number, cursor?: string, sortOrder?: "asc" | "desc") {
    return listSteps(this.ctx.storage.sql, runId, limit, cursor, sortOrder);
  }

  async getEvent(eventId: string, runId: string) {
    return getEvent(this.ctx.storage.sql, eventId, runId);
  }

  async listEvents(runId: string, limit: number, cursor?: string, sortOrder?: "asc" | "desc") {
    return listEvents(this.ctx.storage.sql, runId, limit, cursor, sortOrder);
  }

  async listEventsByCorrelationId(
    correlationId: string,
    runId: string,
    limit: number,
    cursor?: string,
    sortOrder?: "asc" | "desc",
  ) {
    return listEventsByCorrelationId(this.ctx.storage.sql, correlationId, runId, limit, cursor, sortOrder);
  }

  async getHook(hookId: string, runId: string) {
    return getHook(this.ctx.storage.sql, hookId, runId);
  }

  async listHooks(runId: string, limit: number, cursor?: string, sortOrder?: "asc" | "desc") {
    return listHooks(this.ctx.storage.sql, runId, limit, cursor, sortOrder);
  }

  async storageStats() {
    const pageCountRow = this.ctx.storage.sql.exec<{ page_count: number }>("PRAGMA page_count").toArray()[0];
    const pageSizeRow = this.ctx.storage.sql.exec<{ page_size: number }>("PRAGMA page_size").toArray()[0];
    const page_count = pageCountRow?.page_count ?? 0;
    const page_size = pageSizeRow?.page_size ?? 0;
    const storageSizeBytes = page_count * page_size;
    return {
      storageSizeBytes,
      storageSizeKb: Math.round(storageSizeBytes / 1024),
      pageCount: page_count,
      pageSize: page_size,
    };
  }
}
