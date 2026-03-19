/**
 * Lightweight World implementation that proxies all operations through
 * a Cloudflare Service Binding to the generated workflow service worker.
 *
 * This is the World that runs in the user's application worker.
 * It delegates all storage, queue, and streaming operations to the
 * service worker via RPC.
 */

import type {
  CreateEventParams,
  Event,
  EventResult,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  MessageId,
  PaginatedResponse,
  QueueOptions,
  QueuePayload,
  QueuePrefix,
  Step,
  StepWithoutData,
  ValidQueueName,
  WorkflowRun,
  WorkflowRunWithoutData,
  World,
} from "@workflow/world";

/**
 * RPC contract exposed by the WorkflowServiceEntrypoint.
 * Both the entrypoint and the proxy world share this shape.
 */
export interface WorkflowServiceRPC {
  getDeploymentId(): Promise<string>;
  enqueue(queueName: string, message: unknown, opts?: Record<string, unknown>): Promise<{ messageId: unknown }>;

  runsGet(id: string, params?: Record<string, unknown>): Promise<unknown>;
  runsList(params?: Record<string, unknown>): Promise<unknown>;

  stepsGet(runId: string | null, stepId: string, params?: Record<string, unknown>): Promise<unknown>;
  stepsList(params: Record<string, unknown>): Promise<unknown>;

  eventsCreate(runId: string | null, data: Record<string, unknown>, params?: Record<string, unknown>): Promise<unknown>;
  eventsGet(runId: string, eventId: string, params?: Record<string, unknown>): Promise<unknown>;
  eventsList(params: Record<string, unknown>): Promise<unknown>;
  eventsListByCorrelationId(params: Record<string, unknown>): Promise<unknown>;

  hooksGet(hookId: string, params?: Record<string, unknown>): Promise<unknown>;
  hooksGetByToken(token: string, params?: Record<string, unknown>): Promise<unknown>;
  hooksList(params: Record<string, unknown>): Promise<unknown>;

  writeToStream(name: string, runId: string, chunk: string | ArrayBuffer): Promise<void>;
  writeToStreamMulti(name: string, runId: string, chunks: (string | ArrayBuffer)[]): Promise<void>;
  closeStream(name: string, runId: string): Promise<void>;
  readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>>;
  listStreamsByRunId(runId: string): Promise<string[]>;
}

function toArrayBuffer(chunk: string | Uint8Array): string | ArrayBuffer {
  if (typeof chunk === "string") return chunk;
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
}

export function createProxyWorld(service: WorkflowServiceRPC): World {
  return {
    async getDeploymentId() {
      return service.getDeploymentId();
    },

    async queue(queueName: ValidQueueName, message: QueuePayload, opts?: QueueOptions) {
      const result = await service.enqueue(queueName, message, opts as Record<string, unknown>);
      return { messageId: result.messageId as MessageId | null };
    },

    createQueueHandler(_prefix: QueuePrefix) {
      throw new Error(
        "createQueueHandler is not available on the proxy world. " +
          "Queue processing runs in the workflow service worker.",
      );
    },

    runs: {
      get: (async (id: string, params?: GetWorkflowRunParams) => {
        return (await service.runsGet(id, params as Record<string, unknown>)) as WorkflowRun | WorkflowRunWithoutData;
      }) as World["runs"]["get"],

      list: (async (params?: ListWorkflowRunsParams) => {
        return (await service.runsList(params as Record<string, unknown>)) as PaginatedResponse<
          WorkflowRun | WorkflowRunWithoutData
        >;
      }) as World["runs"]["list"],
    },

    steps: {
      get: (async (runId: string | undefined, stepId: string, params?: GetStepParams) => {
        return (await service.stepsGet(runId ?? null, stepId, params as Record<string, unknown>)) as
          | Step
          | StepWithoutData;
      }) as World["steps"]["get"],

      list: (async (params: ListWorkflowRunStepsParams) => {
        return (await service.stepsList(params as unknown as Record<string, unknown>)) as PaginatedResponse<
          Step | StepWithoutData
        >;
      }) as World["steps"]["list"],
    },

    events: {
      create: (async (runId: string | null, data: unknown, params?: CreateEventParams): Promise<EventResult> => {
        return (await service.eventsCreate(
          runId,
          data as Record<string, unknown>,
          params as Record<string, unknown>,
        )) as EventResult;
      }) as World["events"]["create"],

      async get(runId: string, eventId: string, params?: GetEventParams): Promise<Event> {
        return (await service.eventsGet(runId, eventId, params as Record<string, unknown>)) as Event;
      },

      async list(params: ListEventsParams): Promise<PaginatedResponse<Event>> {
        return (await service.eventsList(params as unknown as Record<string, unknown>)) as PaginatedResponse<Event>;
      },

      async listByCorrelationId(params: ListEventsByCorrelationIdParams): Promise<PaginatedResponse<Event>> {
        return (await service.eventsListByCorrelationId(
          params as unknown as Record<string, unknown>,
        )) as PaginatedResponse<Event>;
      },
    },

    hooks: {
      async get(hookId: string, params?: GetHookParams): Promise<Hook> {
        return (await service.hooksGet(hookId, params as Record<string, unknown>)) as Hook;
      },

      async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
        return (await service.hooksGetByToken(token, params as Record<string, unknown>)) as Hook;
      },

      async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
        return (await service.hooksList(params as unknown as Record<string, unknown>)) as PaginatedResponse<Hook>;
      },
    },

    async writeToStream(name: string, runId: string | Promise<string>, chunk: string | Uint8Array): Promise<void> {
      return service.writeToStream(name, await runId, toArrayBuffer(chunk));
    },

    async writeToStreamMulti(
      name: string,
      runId: string | Promise<string>,
      chunks: (string | Uint8Array)[],
    ): Promise<void> {
      return service.writeToStreamMulti(name, await runId, chunks.map(toArrayBuffer));
    },

    async closeStream(name: string, runId: string | Promise<string>): Promise<void> {
      return service.closeStream(name, await runId);
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      return service.readFromStream(name, startIndex);
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      return service.listStreamsByRunId(runId);
    },
  };
}
