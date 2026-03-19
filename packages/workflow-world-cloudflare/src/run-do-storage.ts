/**
 * Event processing logic for the RunDO's internal SQLite.
 *
 * Ported from world-postgres/src/storage.ts, adapted for SQLite.
 * All validation and entity mutations happen within the DO's single-threaded
 * context, giving us serialization guarantees without explicit transactions.
 */

import {
  type Event,
  type EventResult,
  EventSchema,
  type Hook,
  HookSchema,
  isLegacySpecVersion,
  type ResolveData,
  requiresNewerWorld,
  SPEC_VERSION_CURRENT,
  type Step,
  StepSchema,
  type StructuredError,
  stripEventDataRefs,
  validateUlidTimestamp,
  type Wait,
  type WorkflowRun,
  WorkflowRunSchema,
} from "@workflow/world";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

type SqlStorage = DurableObjectState["storage"]["sql"];
type SqlRow = Record<string, SqlStorageValue>;

function compact<T extends Record<string, unknown>>(obj: T): T {
  const result = {} as T;
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== null && obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

function parseJson<T>(json: string | null | undefined): T | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as T;
  } catch {
    return undefined;
  }
}

function toIso(d: Date): string {
  return d.toISOString();
}

function parseDate(s: string | null | undefined): Date | undefined {
  if (!s) return undefined;
  return new Date(s);
}

function requireDate(s: string | null | undefined, field: string): Date {
  const d = parseDate(s);
  if (!d) throw new Error(`Required date field "${field}" is missing or invalid`);
  return d;
}

// SqlStorage returns blob columns as ArrayBuffer, but @workflow/core's
// hydrateWorkflowArguments checks `instanceof Uint8Array`.
function toUint8Array(val: unknown): Uint8Array | undefined {
  if (val == null) return undefined;
  if (val instanceof Uint8Array) return val;
  if (val instanceof ArrayBuffer) return new Uint8Array(val);
  return val as Uint8Array;
}

function rowToRun(row: Record<string, unknown>): WorkflowRun {
  const run = {
    runId: row.runId as string,
    status: row.status as string,
    workflowName: row.workflowName as string,
    deploymentId: row.deploymentId as string,
    specVersion: row.specVersion as number | undefined,
    executionContext: parseJson(row.executionContext as string),
    input: toUint8Array(row.input),
    output: toUint8Array(row.output),
    error: parseJson<StructuredError>(row.error as string),
    expiredAt: parseDate(row.expiredAt as string),
    startedAt: parseDate(row.startedAt as string),
    completedAt: parseDate(row.completedAt as string),
    createdAt: requireDate(row.createdAt as string, "createdAt"),
    updatedAt: requireDate(row.updatedAt as string, "updatedAt"),
  };
  return WorkflowRunSchema.parse(compact(run));
}

function rowToStep(row: Record<string, unknown>): Step {
  const step = {
    runId: (row.runId as string) ?? "",
    stepId: row.stepId as string,
    stepName: row.stepName as string,
    status: row.status as string,
    input: toUint8Array(row.input),
    output: toUint8Array(row.output),
    error: parseJson<StructuredError>(row.error as string),
    attempt: row.attempt as number,
    startedAt: parseDate(row.startedAt as string),
    completedAt: parseDate(row.completedAt as string),
    createdAt: requireDate(row.createdAt as string, "createdAt"),
    updatedAt: requireDate(row.updatedAt as string, "updatedAt"),
    retryAfter: parseDate(row.retryAfter as string),
    specVersion: row.specVersion as number | undefined,
  };
  return StepSchema.parse(compact(step));
}

function rowToHook(row: Record<string, unknown>): Hook {
  const hook = {
    runId: (row.runId as string) ?? "",
    hookId: row.hookId as string,
    token: row.token as string,
    ownerId: "",
    projectId: "",
    environment: "",
    metadata: row.metadata ?? undefined,
    createdAt: requireDate(row.createdAt as string, "createdAt"),
    specVersion: row.specVersion as number | undefined,
    isWebhook: row.isWebhook != null ? Boolean(row.isWebhook) : undefined,
  };
  return HookSchema.parse(compact(hook));
}

// Binary-safe JSON: Uint8Array values survive JSON.stringify round-trips.
// We encode them as { __u8: "<base64>" } objects and restore on parse.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __u8: uint8ToBase64(value) };
  }
  if (value instanceof ArrayBuffer) {
    return { __u8: uint8ToBase64(new Uint8Array(value)) };
  }
  return value;
}

function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "__u8" in (value as Record<string, unknown>)) {
    const encoded = (value as Record<string, string>).__u8 ?? "";
    return base64ToUint8(encoded);
  }
  return value;
}

function uint8ToBase64(u8: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i] ?? 0);
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

function rowToEvent(row: Record<string, unknown>, runId: string): Event {
  const raw = row.eventData as string | null | undefined;
  let eventData: unknown;
  if (raw) {
    try {
      eventData = JSON.parse(raw, jsonReviver);
    } catch {
      eventData = undefined;
    }
  }
  const event = {
    runId,
    eventId: row.eventId as string,
    eventType: row.eventType as string,
    correlationId: row.correlationId as string | undefined,
    eventData,
    specVersion: row.specVersion as number | undefined,
    createdAt: requireDate(row.createdAt as string, "createdAt"),
  };
  return EventSchema.parse(compact(event));
}

function rowToWait(row: Record<string, unknown>, runId: string): Wait {
  return {
    waitId: row.waitId as string,
    runId,
    status: row.status as string,
    resumeAt: parseDate(row.resumeAt as string),
    completedAt: parseDate(row.completedAt as string),
    createdAt: requireDate(row.createdAt as string, "createdAt"),
    updatedAt: requireDate(row.updatedAt as string, "updatedAt"),
    specVersion: row.specVersion as number | undefined,
  } as Wait;
}

const isRunTerminal = (s: string) => ["completed", "failed", "cancelled"].includes(s);
const isStepTerminal = (s: string) => ["completed", "failed"].includes(s);

export interface D1IndexSync {
  syncRun(run: WorkflowRun): Promise<void>;
  syncEvent(eventId: string, correlationId: string | undefined, runId: string): Promise<void>;
  syncStep(stepId: string, runId: string): Promise<void>;
  syncHookCreated(hookId: string, token: string, runId: string): Promise<void>;
  syncHookDeleted(runId: string): Promise<void>;
  checkTokenUniqueness(token: string): Promise<boolean>;
}

// --- Shared context type for event mutation handlers ---
type MutationCtx = { sql: SqlStorage; runId: string; specVersion: number; nowIso: string; d1Sync: D1IndexSync };
type ValidatedStep = { status: string; startedAt: string | null; retryAfter: string | null };

// --- Validation helpers ---

function resolveRunId(runId: string, eventType: unknown): string {
  if (eventType === "run_created" && (!runId || runId === "")) return `wrun_${ulid()}`;
  return runId;
}

function validateRunCreation(effectiveRunId: string, runId: string, eventType: unknown): void {
  if (eventType !== "run_created" || !runId || runId === "") return;
  const err = validateUlidTimestamp(effectiveRunId, "wrun_");
  if (err) throw new Error(err);
}

function fetchCurrentRun(
  sql: SqlStorage,
  effectiveRunId: string,
  eventType: unknown,
): { status: string; specVersion: number | null } | null {
  const skip = ["run_created", "step_completed", "step_retrying"];
  if (skip.includes(eventType as string)) return null;
  const rows = sql
    .exec<{ status: string; specVersion: number | null }>(
      "SELECT status, specVersion FROM run WHERE runId = ? LIMIT 1",
      effectiveRunId,
    )
    .toArray();
  return rows[0] ?? null;
}

function checkTerminalState(
  currentRun: { status: string; specVersion: number | null } | null,
  data: Record<string, unknown>,
  sql: SqlStorage,
  effectiveRunId: string,
  eventId: string,
  effectiveSpecVersion: number,
  resolveData: ResolveData,
): EventResult | null {
  if (!currentRun || !isRunTerminal(currentRun.status)) return null;
  if (data.eventType === "run_cancelled" && currentRun.status === "cancelled") {
    insertEvent(sql, effectiveRunId, eventId, data, effectiveSpecVersion);
    const runRows = sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ? LIMIT 1", effectiveRunId).toArray();
    return {
      event: stripEventDataRefs(getInsertedEvent(sql, effectiveRunId, eventId, data), resolveData),
      run: runRows[0] ? rowToRun(runRows[0]) : undefined,
    };
  }
  const terminalEvents = ["run_started", "run_completed", "run_failed", "run_cancelled"];
  if (terminalEvents.includes(data.eventType as string))
    throw new Error(`Cannot transition run from terminal state "${currentRun.status}"`);
  const creationEvents = ["step_created", "hook_created", "wait_created"];
  if (creationEvents.includes(data.eventType as string))
    throw new Error(`Cannot create new entities on run in terminal state "${currentRun.status}"`);
  return null;
}

function fetchValidatedStep(
  sql: SqlStorage,
  eventType: unknown,
  correlationId: unknown,
  currentRun: { status: string } | null,
): ValidatedStep | null {
  if (!["step_started", "step_retrying"].includes(eventType as string) || !correlationId) return null;
  const rows = sql
    .exec<ValidatedStep>(
      "SELECT status, startedAt, retryAfter FROM steps WHERE stepId = ? LIMIT 1",
      correlationId as string,
    )
    .toArray();
  const vs = rows[0] ?? null;
  if (!vs) throw new Error(`Step "${correlationId}" not found`);
  if (isStepTerminal(vs.status)) throw new Error(`Cannot modify step in terminal state "${vs.status}"`);
  if (currentRun && isRunTerminal(currentRun.status) && vs.status !== "running")
    throw new Error(`Cannot modify non-running step on run in terminal state "${currentRun.status}"`);
  return vs;
}

function validateHook(sql: SqlStorage, eventType: unknown, correlationId: unknown): void {
  if (!["hook_disposed", "hook_received"].includes(eventType as string) || !correlationId) return;
  const rows = sql
    .exec<{ hookId: string }>("SELECT hookId FROM hooks WHERE hookId = ? LIMIT 1", correlationId as string)
    .toArray();
  if (rows.length === 0) throw new Error(`Hook "${correlationId}" not found`);
}

// --- Entity mutation handlers ---

function serializeBlob(val: unknown): unknown {
  return val != null ? (val instanceof Uint8Array ? val : JSON.stringify(val)) : null;
}

function buildErrorObj(ed: Record<string, unknown>, stackField = "stack"): StructuredError {
  const raw = ed.error;
  const message =
    typeof raw === "string" ? raw : (((raw as Record<string, unknown>)?.message as string) ?? "Unknown error");
  return { message, stack: ed[stackField] as string | undefined, code: ed.errorCode as string | undefined };
}

function syncRunAndHooks(run: WorkflowRun, runId: string, d1Sync: D1IndexSync): void {
  d1Sync.syncRun(run).catch(() => {});
  d1Sync.syncHookDeleted(runId).catch(() => {});
}

function mutRunCreated(ctx: MutationCtx, data: Record<string, unknown>): WorkflowRun | undefined {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `INSERT OR IGNORE INTO run (runId, status, workflowName, deploymentId, specVersion, input, executionContext, createdAt, updatedAt) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    ctx.runId,
    ed.workflowName as string,
    ed.deploymentId as string,
    ctx.specVersion,
    serializeBlob(ed.input),
    ed.executionContext ? JSON.stringify(ed.executionContext) : null,
    ctx.nowIso,
    ctx.nowIso,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", ctx.runId).toArray();
  if (!rows[0]) return undefined;
  const run = rowToRun({ ...rows[0], runId: ctx.runId });
  ctx.d1Sync.syncRun(run).catch(() => {});
  return run;
}

function mutRunStarted(ctx: MutationCtx): WorkflowRun | undefined {
  ctx.sql.exec(
    `UPDATE run SET status = 'running', startedAt = ?, updatedAt = ? WHERE runId = ?`,
    ctx.nowIso,
    ctx.nowIso,
    ctx.runId,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", ctx.runId).toArray();
  if (!rows[0]) return undefined;
  const run = rowToRun(rows[0]);
  ctx.d1Sync.syncRun(run).catch(() => {});
  return run;
}

function mutRunCompleted(ctx: MutationCtx, data: Record<string, unknown>): WorkflowRun | undefined {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `UPDATE run SET status = 'completed', output = ?, completedAt = ?, updatedAt = ? WHERE runId = ?`,
    serializeBlob(ed.output),
    ctx.nowIso,
    ctx.nowIso,
    ctx.runId,
  );
  ctx.sql.exec("DELETE FROM hooks WHERE 1=1");
  ctx.sql.exec("DELETE FROM waits WHERE 1=1");
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", ctx.runId).toArray();
  if (!rows[0]) return undefined;
  const run = rowToRun(rows[0]);
  syncRunAndHooks(run, ctx.runId, ctx.d1Sync);
  return run;
}

function mutRunFailed(ctx: MutationCtx, data: Record<string, unknown>): WorkflowRun | undefined {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `UPDATE run SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE runId = ?`,
    JSON.stringify(buildErrorObj(ed)),
    ctx.nowIso,
    ctx.nowIso,
    ctx.runId,
  );
  ctx.sql.exec("DELETE FROM hooks WHERE 1=1");
  ctx.sql.exec("DELETE FROM waits WHERE 1=1");
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", ctx.runId).toArray();
  if (!rows[0]) return undefined;
  const run = rowToRun(rows[0]);
  syncRunAndHooks(run, ctx.runId, ctx.d1Sync);
  return run;
}

function mutRunCancelled(ctx: MutationCtx): WorkflowRun | undefined {
  ctx.sql.exec(
    `UPDATE run SET status = 'cancelled', completedAt = ?, updatedAt = ? WHERE runId = ?`,
    ctx.nowIso,
    ctx.nowIso,
    ctx.runId,
  );
  ctx.sql.exec("DELETE FROM hooks WHERE 1=1");
  ctx.sql.exec("DELETE FROM waits WHERE 1=1");
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", ctx.runId).toArray();
  if (!rows[0]) return undefined;
  const run = rowToRun(rows[0]);
  syncRunAndHooks(run, ctx.runId, ctx.d1Sync);
  return run;
}

function mutStepCreated(ctx: MutationCtx, data: Record<string, unknown>): Step | undefined {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `INSERT OR IGNORE INTO steps (stepId, stepName, status, input, attempt, specVersion, createdAt, updatedAt) VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)`,
    data.correlationId as string,
    ed.stepName as string,
    serializeBlob(ed.input),
    ctx.specVersion,
    ctx.nowIso,
    ctx.nowIso,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ?", data.correlationId as string).toArray();
  if (!rows[0]) return undefined;
  const step = rowToStep({ ...rows[0], runId: ctx.runId });
  ctx.d1Sync.syncStep(data.correlationId as string, ctx.runId).catch(() => {});
  return step;
}

function mutStepStarted(ctx: MutationCtx, data: Record<string, unknown>, vs: ValidatedStep | null): Step | undefined {
  if (vs?.retryAfter) {
    const retryAfterTime = new Date(vs.retryAfter).getTime();
    if (retryAfterTime > Date.now()) {
      throw Object.assign(
        new Error(`Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`),
        { meta: { stepId: data.correlationId, retryAfter: vs.retryAfter } },
      );
    }
  }
  const isFirstStart = !vs?.startedAt;
  ctx.sql.exec(
    `UPDATE steps SET status = 'running', attempt = attempt + 1${isFirstStart ? ", startedAt = ?" : ""}${vs?.retryAfter ? ", retryAfter = NULL" : ""}, updatedAt = ? WHERE stepId = ?`,
    ...(isFirstStart ? [ctx.nowIso] : []),
    ctx.nowIso,
    data.correlationId as string,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ?", data.correlationId as string).toArray();
  return rows[0] ? rowToStep({ ...rows[0], runId: ctx.runId }) : undefined;
}

function mutStepCompleted(ctx: MutationCtx, data: Record<string, unknown>): Step {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `UPDATE steps SET status = 'completed', output = ?, completedAt = ?, updatedAt = ? WHERE stepId = ? AND status NOT IN ('completed', 'failed')`,
    serializeBlob(ed.result),
    ctx.nowIso,
    ctx.nowIso,
    data.correlationId as string,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ?", data.correlationId as string).toArray();
  if (!rows[0]) throw new Error(`Step "${data.correlationId}" not found`);
  const step = rowToStep({ ...rows[0], runId: ctx.runId });
  if (isStepTerminal(step.status) && step.status !== "completed")
    throw new Error(`Cannot modify step in terminal state "${step.status}"`);
  return step;
}

function mutStepFailed(ctx: MutationCtx, data: Record<string, unknown>): Step {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `UPDATE steps SET status = 'failed', error = ?, completedAt = ?, updatedAt = ? WHERE stepId = ? AND status NOT IN ('completed', 'failed')`,
    JSON.stringify({
      message:
        typeof ed.error === "string"
          ? ed.error
          : (((ed.error as Record<string, unknown>)?.message as string) ?? "Unknown error"),
      stack: ed.stack as string | undefined,
    }),
    ctx.nowIso,
    ctx.nowIso,
    data.correlationId as string,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ?", data.correlationId as string).toArray();
  if (!rows[0]) throw new Error(`Step "${data.correlationId}" not found`);
  return rowToStep({ ...rows[0], runId: ctx.runId });
}

function mutStepRetrying(ctx: MutationCtx, data: Record<string, unknown>): Step | undefined {
  const ed = data.eventData as Record<string, unknown>;
  ctx.sql.exec(
    `UPDATE steps SET status = 'pending', error = ?, retryAfter = ?, updatedAt = ? WHERE stepId = ?`,
    JSON.stringify({
      message:
        typeof ed.error === "string"
          ? ed.error
          : (((ed.error as Record<string, unknown>)?.message as string) ?? "Unknown error"),
      stack: ed.stack as string | undefined,
    }),
    ed.retryAfter ? toIso(new Date(ed.retryAfter as string)) : null,
    ctx.nowIso,
    data.correlationId as string,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ?", data.correlationId as string).toArray();
  return rows[0] ? rowToStep({ ...rows[0], runId: ctx.runId }) : undefined;
}

/** Returns an early EventResult if there's a token conflict, otherwise returns the created hook. */
function mutHookCreated(
  ctx: MutationCtx,
  data: Record<string, unknown>,
  eventId: string,
  resolveData: ResolveData,
): { earlyReturn: EventResult } | { hook: Hook | undefined } {
  const ed = data.eventData as Record<string, unknown>;
  const token = ed.token as string;
  const existingLocal = ctx.sql
    .exec<{ hookId: string }>("SELECT hookId FROM hooks WHERE token = ? LIMIT 1", token)
    .toArray();
  if (existingLocal.length > 0) {
    const conflictData = { ...data, eventType: "hook_conflict", eventData: { token } };
    insertEvent(ctx.sql, ctx.runId, eventId, conflictData, ctx.specVersion);
    return {
      earlyReturn: {
        event: stripEventDataRefs(getInsertedEvent(ctx.sql, ctx.runId, eventId, conflictData), resolveData),
      },
    };
  }
  ctx.sql.exec(
    "INSERT OR IGNORE INTO hooks (hookId, token, metadata, isWebhook, specVersion, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    data.correlationId as string,
    token,
    serializeBlob(ed.metadata),
    ed.isWebhook != null ? (ed.isWebhook ? 1 : 0) : null,
    ctx.specVersion,
    ctx.nowIso,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM hooks WHERE hookId = ?", data.correlationId as string).toArray();
  if (!rows[0]) return { hook: undefined };
  const hook = rowToHook({ ...rows[0], runId: ctx.runId });
  ctx.d1Sync.syncHookCreated(data.correlationId as string, token, ctx.runId).catch(() => {});
  return { hook };
}

function mutWaitCreated(ctx: MutationCtx, data: Record<string, unknown>): Wait | undefined {
  const ed = data.eventData as Record<string, unknown>;
  const waitId = `${ctx.runId}-${data.correlationId}`;
  ctx.sql.exec(
    `INSERT OR IGNORE INTO waits (waitId, status, resumeAt, specVersion, createdAt, updatedAt) VALUES (?, 'waiting', ?, ?, ?, ?)`,
    waitId,
    ed.resumeAt ? toIso(new Date(ed.resumeAt as string)) : null,
    ctx.specVersion,
    ctx.nowIso,
    ctx.nowIso,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM waits WHERE waitId = ?", waitId).toArray();
  return rows[0] ? rowToWait(rows[0], ctx.runId) : undefined;
}

function mutWaitCompleted(ctx: MutationCtx, data: Record<string, unknown>): Wait {
  const waitId = `${ctx.runId}-${data.correlationId}`;
  ctx.sql.exec(
    `UPDATE waits SET status = 'completed', completedAt = ?, updatedAt = ? WHERE waitId = ? AND status = 'waiting'`,
    ctx.nowIso,
    ctx.nowIso,
    waitId,
  );
  const rows = ctx.sql.exec<SqlRow>("SELECT * FROM waits WHERE waitId = ?", waitId).toArray();
  if (!rows[0]) throw new Error(`Wait "${data.correlationId}" not found`);
  return rowToWait(rows[0], ctx.runId);
}

// --- Dispatch ---

function applyMutation(
  ctx: MutationCtx,
  data: Record<string, unknown>,
  vs: ValidatedStep | null,
  eventId: string,
  resolveData: ResolveData,
): { run?: WorkflowRun; step?: Step; hook?: Hook; wait?: Wait; earlyReturn?: EventResult } {
  switch (data.eventType) {
    case "run_created":
      return { run: mutRunCreated(ctx, data) };
    case "run_started":
      return { run: mutRunStarted(ctx) };
    case "run_completed":
      return { run: mutRunCompleted(ctx, data) };
    case "run_failed":
      return { run: mutRunFailed(ctx, data) };
    case "run_cancelled":
      return { run: mutRunCancelled(ctx) };
    case "step_created":
      return { step: mutStepCreated(ctx, data) };
    case "step_started":
      return { step: mutStepStarted(ctx, data, vs) };
    case "step_completed":
      return { step: mutStepCompleted(ctx, data) };
    case "step_failed":
      return { step: mutStepFailed(ctx, data) };
    case "step_retrying":
      return { step: mutStepRetrying(ctx, data) };
    case "hook_created": {
      const r = mutHookCreated(ctx, data, eventId, resolveData);
      return "earlyReturn" in r ? r : r;
    }
    case "hook_disposed":
      ctx.sql.exec("DELETE FROM hooks WHERE hookId = ?", data.correlationId as string);
      return {};
    case "wait_created":
      return { wait: mutWaitCreated(ctx, data) };
    case "wait_completed":
      return { wait: mutWaitCompleted(ctx, data) };
    default:
      return {};
  }
}

/**
 * Process an event creation request within a RunDO.
 * This is the core event-sourcing logic, adapted from world-postgres.
 */
export function processEvent(
  sql: SqlStorage,
  runId: string,
  data: Record<string, unknown>,
  params: { resolveData?: ResolveData } | undefined,
  d1Sync: D1IndexSync,
): EventResult {
  const eventId = `wevt_${ulid()}`;
  const resolveData = params?.resolveData ?? "all";
  const nowIso = toIso(new Date());
  const effectiveRunId = resolveRunId(runId, data.eventType);
  validateRunCreation(effectiveRunId, runId, data.eventType);
  const effectiveSpecVersion = (data.specVersion as number) ?? SPEC_VERSION_CURRENT;
  const currentRun = fetchCurrentRun(sql, effectiveRunId, data.eventType);

  if (currentRun) {
    if (requiresNewerWorld(currentRun.specVersion))
      throw new Error(
        `Run requires spec version ${currentRun.specVersion}, but this world supports ${SPEC_VERSION_CURRENT}`,
      );
    if (isLegacySpecVersion(currentRun.specVersion))
      return handleLegacyEvent(sql, effectiveRunId, eventId, data, currentRun, resolveData, d1Sync);
  }

  const terminalResult = checkTerminalState(
    currentRun,
    data,
    sql,
    effectiveRunId,
    eventId,
    effectiveSpecVersion,
    resolveData,
  );
  if (terminalResult) return terminalResult;

  const vs = fetchValidatedStep(sql, data.eventType, data.correlationId, currentRun);
  validateHook(sql, data.eventType, data.correlationId);

  const ctx: MutationCtx = { sql, runId: effectiveRunId, specVersion: effectiveSpecVersion, nowIso, d1Sync };
  const mutations = applyMutation(ctx, data, vs, eventId, resolveData);
  if (mutations.earlyReturn) return mutations.earlyReturn;

  insertEvent(sql, effectiveRunId, eventId, data, effectiveSpecVersion);
  const event = getInsertedEvent(sql, effectiveRunId, eventId, data);
  d1Sync.syncEvent(eventId, data.correlationId as string | undefined, effectiveRunId).catch(() => {});
  return {
    event: stripEventDataRefs(event, resolveData),
    run: mutations.run,
    step: mutations.step,
    hook: mutations.hook,
    wait: mutations.wait,
  };
}

function insertEvent(
  sql: SqlStorage,
  _runId: string,
  eventId: string,
  data: Record<string, unknown>,
  specVersion: number,
): void {
  sql.exec(
    `INSERT INTO events (eventId, eventType, correlationId, eventData, specVersion, createdAt)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    eventId,
    data.eventType as string,
    (data.correlationId as string) ?? null,
    "eventData" in data && data.eventData != null ? JSON.stringify(data.eventData, jsonReplacer) : null,
    specVersion,
  );
}

function getInsertedEvent(sql: SqlStorage, runId: string, eventId: string, _data: Record<string, unknown>): Event {
  const rows = sql.exec<SqlRow>("SELECT * FROM events WHERE eventId = ? LIMIT 1", eventId).toArray();
  if (!rows[0]) {
    throw new Error(`Event ${eventId} could not be created`);
  }
  return rowToEvent(rows[0], runId);
}

function handleLegacyEvent(
  sql: SqlStorage,
  runId: string,
  eventId: string,
  data: Record<string, unknown>,
  _currentRun: { status: string; specVersion: number | null },
  resolveData: ResolveData,
  d1Sync: D1IndexSync,
): EventResult {
  const nowIso = toIso(new Date());

  switch (data.eventType) {
    case "run_cancelled": {
      sql.exec(
        `UPDATE run SET status = 'cancelled', completedAt = ?, updatedAt = ? WHERE runId = ?`,
        nowIso,
        nowIso,
        runId,
      );
      sql.exec("DELETE FROM hooks WHERE 1=1");
      sql.exec("DELETE FROM waits WHERE 1=1");
      const rows = sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ?", runId).toArray();
      const run = rows[0] ? rowToRun(rows[0]) : undefined;
      if (run) d1Sync.syncRun(run).catch(() => {});
      return { run };
    }

    case "wait_completed":
    case "hook_received": {
      insertEvent(sql, runId, eventId, data, SPEC_VERSION_CURRENT);
      const event = getInsertedEvent(sql, runId, eventId, data);
      return { event: stripEventDataRefs(event, resolveData) };
    }

    default:
      throw new Error(`Event type '${data.eventType}' not supported for legacy runs`);
  }
}

// Query helpers for reads
export function getRun(sql: SqlStorage, runId: string): WorkflowRun | undefined {
  const rows = sql.exec<SqlRow>("SELECT * FROM run WHERE runId = ? LIMIT 1", runId).toArray();
  return rows[0] ? rowToRun(rows[0]) : undefined;
}

export function getStep(sql: SqlStorage, stepId: string, runId: string): Step | undefined {
  const rows = sql.exec<SqlRow>("SELECT * FROM steps WHERE stepId = ? LIMIT 1", stepId).toArray();
  return rows[0] ? rowToStep({ ...rows[0], runId }) : undefined;
}

export function listSteps(
  sql: SqlStorage,
  runId: string,
  limit: number,
  cursor?: string,
  sortOrder: "asc" | "desc" = "desc",
): { data: Step[]; cursor: string | null; hasMore: boolean } {
  const op = sortOrder === "desc" ? "<" : ">";
  const order = sortOrder === "desc" ? "DESC" : "ASC";
  const query = cursor
    ? `SELECT * FROM steps WHERE stepId ${op} ? ORDER BY stepId ${order} LIMIT ?`
    : `SELECT * FROM steps ORDER BY stepId ${order} LIMIT ?`;
  const args = cursor ? [cursor, limit + 1] : [limit + 1];
  const rows = sql.exec<SqlRow>(query, ...args).toArray();
  const values = rows.slice(0, limit);
  return {
    data: values.map((r) => rowToStep({ ...r, runId })),
    cursor: ((values.at(-1) as Record<string, unknown> | undefined)?.stepId as string) ?? null,
    hasMore: rows.length > limit,
  };
}

export function getEvent(sql: SqlStorage, eventId: string, runId: string): Event | undefined {
  const rows = sql.exec<SqlRow>("SELECT * FROM events WHERE eventId = ? LIMIT 1", eventId).toArray();
  return rows[0] ? rowToEvent(rows[0], runId) : undefined;
}

export function listEvents(
  sql: SqlStorage,
  runId: string,
  limit: number,
  cursor?: string,
  sortOrder: "asc" | "desc" = "asc",
): { data: Event[]; cursor: string | null; hasMore: boolean } {
  const op = sortOrder === "desc" ? "<" : ">";
  const order = sortOrder === "desc" ? "DESC" : "ASC";
  const query = cursor
    ? `SELECT * FROM events WHERE eventId ${op} ? ORDER BY eventId ${order} LIMIT ?`
    : `SELECT * FROM events ORDER BY eventId ${order} LIMIT ?`;
  const args = cursor ? [cursor, limit + 1] : [limit + 1];
  const rows = sql.exec<SqlRow>(query, ...args).toArray();
  const values = rows.slice(0, limit);
  return {
    data: values.map((r) => rowToEvent(r, runId)),
    cursor: ((values.at(-1) as Record<string, unknown> | undefined)?.eventId as string) ?? null,
    hasMore: rows.length > limit,
  };
}

export function listEventsByCorrelationId(
  sql: SqlStorage,
  correlationId: string,
  runId: string,
  limit: number,
  cursor?: string,
  sortOrder: "asc" | "desc" = "asc",
): { data: Event[]; cursor: string | null; hasMore: boolean } {
  const op = sortOrder === "desc" ? "<" : ">";
  const order = sortOrder === "desc" ? "DESC" : "ASC";
  const query = cursor
    ? `SELECT * FROM events WHERE correlationId = ? AND eventId ${op} ? ORDER BY eventId ${order} LIMIT ?`
    : `SELECT * FROM events WHERE correlationId = ? ORDER BY eventId ${order} LIMIT ?`;
  const args = cursor ? [correlationId, cursor, limit + 1] : [correlationId, limit + 1];
  const rows = sql.exec<SqlRow>(query, ...args).toArray();
  const values = rows.slice(0, limit);
  return {
    data: values.map((r) => rowToEvent(r, runId)),
    cursor: ((values.at(-1) as Record<string, unknown> | undefined)?.eventId as string) ?? null,
    hasMore: rows.length > limit,
  };
}

export function getHook(sql: SqlStorage, hookId: string, runId: string): Hook | undefined {
  const rows = sql.exec<SqlRow>("SELECT * FROM hooks WHERE hookId = ? LIMIT 1", hookId).toArray();
  return rows[0] ? rowToHook({ ...rows[0], runId }) : undefined;
}

export function listHooks(
  sql: SqlStorage,
  runId: string,
  limit: number,
  cursor?: string,
  sortOrder: "asc" | "desc" = "asc",
): { data: Hook[]; cursor: string | null; hasMore: boolean } {
  const op = sortOrder === "desc" ? "<" : ">";
  const order = sortOrder === "desc" ? "DESC" : "ASC";
  const query = cursor
    ? `SELECT * FROM hooks WHERE hookId ${op} ? ORDER BY hookId ${order} LIMIT ?`
    : `SELECT * FROM hooks ORDER BY hookId ${order} LIMIT ?`;
  const args = cursor ? [cursor, limit + 1] : [limit + 1];
  const rows = sql.exec<SqlRow>(query, ...args).toArray();
  const values = rows.slice(0, limit);
  return {
    data: values.map((r) => rowToHook({ ...r, runId })),
    cursor: ((values.at(-1) as Record<string, unknown> | undefined)?.hookId as string) ?? null,
    hasMore: rows.length > limit,
  };
}
