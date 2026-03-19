/**
 * RPC entrypoint for the generated workflow service worker.
 *
 * Extends Cloudflare's WorkerEntrypoint to expose typed RPC methods
 * that the CloudflareProxyWorld calls through a Service Binding.
 * All actual workflow logic (D1, DOs, Queues) lives here.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { World } from "@workflow/world";
import { createCloudflareWorld } from "./index.js";
import type { WorkflowServiceRPC } from "./proxy-world.js";

interface ServiceWorkerEnv {
  WORKFLOW_DB: D1Database;
  RUN_DO: DurableObjectNamespace;
  STREAM_DO: DurableObjectNamespace;
  WORKFLOW_QUEUE: Queue;
  WORKFLOW_STEP_QUEUE: Queue;
  WORKFLOW_INSPECT_TOKEN?: string;
}

export class WorkflowServiceEntrypoint extends WorkerEntrypoint<ServiceWorkerEnv> implements WorkflowServiceRPC {
  private worldPromise: Promise<World> | null = null;

  private getWorld(): Promise<World> {
    if (!this.worldPromise) {
      this.worldPromise = createCloudflareWorld(this.env as unknown as Record<string, unknown>);
    }
    return this.worldPromise;
  }

  async getDeploymentId(): Promise<string> {
    const world = await this.getWorld();
    return world.getDeploymentId();
  }

  async enqueue(queueName: string, message: unknown, opts?: Record<string, unknown>): Promise<{ messageId: unknown }> {
    const world = await this.getWorld();
    const result = await world.queue(
      queueName as Parameters<World["queue"]>[0],
      message as Parameters<World["queue"]>[1],
      opts as Parameters<World["queue"]>[2],
    );
    return { messageId: result.messageId };
  }

  async runsGet(id: string, params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.runs.get(id, params as never);
  }

  async runsList(params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.runs.list(params as never);
  }

  async stepsGet(runId: string | null, stepId: string, params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.steps.get(runId ?? undefined, stepId, params as never);
  }

  async stepsList(params: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.steps.list(params as never);
  }

  async eventsCreate(
    runId: string | null,
    data: Record<string, unknown>,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const world = await this.getWorld();
    return world.events.create(runId as string, data as never, params as never);
  }

  async eventsGet(runId: string, eventId: string, params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.events.get(runId, eventId, params as never);
  }

  async eventsList(params: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.events.list(params as never);
  }

  async eventsListByCorrelationId(params: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.events.listByCorrelationId(params as never);
  }

  async hooksGet(hookId: string, params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.hooks.get(hookId, params as never);
  }

  async hooksGetByToken(token: string, params?: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.hooks.getByToken(token, params as never);
  }

  async hooksList(params: Record<string, unknown>): Promise<unknown> {
    const world = await this.getWorld();
    return world.hooks.list(params as never);
  }

  async writeToStream(name: string, runId: string, chunk: string | ArrayBuffer): Promise<void> {
    const world = await this.getWorld();
    const data = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
    return world.writeToStream(name, runId, data);
  }

  async writeToStreamMulti(name: string, runId: string, chunks: (string | ArrayBuffer)[]): Promise<void> {
    const world = await this.getWorld();
    const mapped = chunks.map((c) => (c instanceof ArrayBuffer ? new Uint8Array(c) : c));
    if (world.writeToStreamMulti) {
      return world.writeToStreamMulti(name, runId, mapped);
    }
    for (const c of mapped) {
      await world.writeToStream(name, runId, c);
    }
  }

  async closeStream(name: string, runId: string): Promise<void> {
    const world = await this.getWorld();
    return world.closeStream(name, runId);
  }

  async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
    const world = await this.getWorld();
    return world.readFromStream(name, startIndex);
  }

  async listStreamsByRunId(runId: string): Promise<string[]> {
    const world = await this.getWorld();
    return world.listStreamsByRunId(runId);
  }
}
