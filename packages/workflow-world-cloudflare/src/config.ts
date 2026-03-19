/**
 * Required Cloudflare binding names used by the world implementation.
 * Shared between the builder (for wrangler config generation) and the
 * runtime (for extracting bindings from env).
 */
export const BINDING_NAMES = {
  D1_DATABASE: "WORKFLOW_DB",
  RUN_DO: "RUN_DO",
  STREAM_DO: "STREAM_DO",
  WORKFLOW_QUEUE: "WORKFLOW_QUEUE",
  STEP_QUEUE: "WORKFLOW_STEP_QUEUE",
} as const;

export const QUEUE_NAMES = {
  WORKFLOW: "workflow-runs",
  STEP: "workflow-steps",
} as const;

export const DO_CLASS_NAMES = {
  RUN: "WorkflowRunDO",
  STREAM: "WorkflowStreamDO",
} as const;

export interface CloudflareWorldConfig {
  db: D1Database;
  runDO: DurableObjectNamespace;
  streamDO: DurableObjectNamespace;
  workflowQueue: Queue;
  stepQueue: Queue;
  deploymentId?: string;
}

/**
 * D1 schema DDL statements for the global index tables.
 * All use IF NOT EXISTS so they are safe to run on every cold start.
 */
export const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workflow_runs_index (runId TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', workflowName TEXT NOT NULL, deploymentId TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')), startedAt TEXT, completedAt TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs_index(status)",
  "CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs_index(workflowName)",
  "CREATE TABLE IF NOT EXISTS workflow_hooks_index (hookId TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, runId TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_hooks_token ON workflow_hooks_index(token)",
  "CREATE INDEX IF NOT EXISTS idx_hooks_runId ON workflow_hooks_index(runId)",
  "CREATE TABLE IF NOT EXISTS workflow_steps_index (stepId TEXT PRIMARY KEY, runId TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_steps_runId ON workflow_steps_index(runId)",
  "CREATE TABLE IF NOT EXISTS workflow_events_index (eventId TEXT PRIMARY KEY, correlationId TEXT, runId TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_events_runId ON workflow_events_index(runId)",
  "CREATE INDEX IF NOT EXISTS idx_events_correlationId ON workflow_events_index(correlationId)",
  "CREATE TABLE IF NOT EXISTS workflow_streams_index (streamName TEXT PRIMARY KEY, runId TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_streams_runId ON workflow_streams_index(runId)",
] as const;
