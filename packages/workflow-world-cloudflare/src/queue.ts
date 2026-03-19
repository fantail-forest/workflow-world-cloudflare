import { JsonTransport } from "@vercel/queue";
import {
  MessageId as MessageIdSchema,
  type Queue,
  type QueueOptions,
  type QueuePayload,
  type QueuePrefix,
  type ValidQueueName,
} from "@workflow/world";
import { monotonicFactory } from "ulid";
import type { CloudflareWorldConfig } from "./config.js";
import { createQueueConsumer } from "./queue-consumer.js";

const MAX_QUEUE_DELAY_SECONDS = 86_400; // CF Queues 24h limit

export type CloudflareQueue = Queue & {
  start?(): Promise<void>;
  close?(): Promise<void>;
};

export function createQueue(config: CloudflareWorldConfig): CloudflareQueue {
  const transport = new JsonTransport();
  const generateId = monotonicFactory();

  const queueBindings: Record<QueuePrefix, globalThis.Queue> = {
    __wkf_workflow_: config.workflowQueue,
    __wkf_step_: config.stepQueue,
  };

  function getQueuePrefix(name: ValidQueueName): QueuePrefix {
    if (name.startsWith("__wkf_step_")) return "__wkf_step_";
    if (name.startsWith("__wkf_workflow_")) return "__wkf_workflow_";
    throw new Error(`Invalid queue name: ${name}`);
  }

  const queue: Queue["queue"] = async (queueName: ValidQueueName, message: QueuePayload, opts?: QueueOptions) => {
    const prefix = getQueuePrefix(queueName);
    const cfQueue = queueBindings[prefix];
    const body = transport.serialize(message);
    const messageId = MessageIdSchema.parse(`msg_${generateId()}`);

    const effectiveDelay = opts?.delaySeconds ? Math.min(opts.delaySeconds, MAX_QUEUE_DELAY_SECONDS) : undefined;

    await cfQueue.send(
      {
        queueName,
        messageId,
        body: Array.from(body),
        attempt: 1,
        idempotencyKey: opts?.idempotencyKey,
        headers: opts?.headers,
        originalDelaySeconds: opts?.delaySeconds,
      },
      effectiveDelay ? { delaySeconds: effectiveDelay } : undefined,
    );

    return { messageId };
  };

  const createQueueHandler = createQueueConsumer(transport);

  const getDeploymentId: Queue["getDeploymentId"] = async () => {
    return config.deploymentId ?? "cloudflare";
  };

  return {
    queue,
    createQueueHandler,
    getDeploymentId,
  };
}
