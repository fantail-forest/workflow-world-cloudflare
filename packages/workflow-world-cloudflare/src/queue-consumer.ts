import type { JsonTransport } from "@vercel/queue";
import type { MessageId, Queue, QueuePrefix, ValidQueueName } from "@workflow/world";
import * as z from "zod";

const MAX_QUEUE_DELAY_SECONDS = 86_400;

const HeaderParser = z.object({
  "x-vqs-queue-name": z.string(),
  "x-vqs-message-id": z.string(),
  "x-vqs-message-attempt": z.coerce.number(),
});

/**
 * Schema for messages on the CF Queue. Carries the serialized payload
 * along with routing metadata.
 */
export const QueueMessageSchema = z.object({
  queueName: z.string(),
  messageId: z.string(),
  body: z.array(z.number()),
  attempt: z.number(),
  idempotencyKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  originalDelaySeconds: z.number().optional(),
});
export type QueueMessage = z.infer<typeof QueueMessageSchema>;

/**
 * Creates a `createQueueHandler` function compatible with the Queue interface.
 * This is the in-process version for CF Workers -- no HTTP round-trip.
 */
function parseQueueRequest(req: Request, prefix: QueuePrefix) {
  const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));
  if (!headers.success || !req.body) {
    return { error: !req.body ? "Missing request body" : "Missing required headers" };
  }
  const queueName = headers.data["x-vqs-queue-name"] as ValidQueueName;
  if (!queueName.startsWith(prefix)) {
    return { error: "Unhandled queue" };
  }
  return {
    queueName,
    messageId: headers.data["x-vqs-message-id"] as MessageId,
    attempt: headers.data["x-vqs-message-attempt"],
    body: req.body,
  };
}

export function createQueueConsumer(transport: JsonTransport): Queue["createQueueHandler"] {
  return (prefix: QueuePrefix, handler) => {
    return async (req: Request) => {
      const parsed = parseQueueRequest(req, prefix);
      if ("error" in parsed) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }

      const body = await transport.deserialize(parsed.body);
      try {
        const result = await handler(body, {
          attempt: parsed.attempt,
          queueName: parsed.queueName,
          messageId: parsed.messageId,
        });
        if (typeof result?.timeoutSeconds === "number") {
          return Response.json({ timeoutSeconds: Math.min(result.timeoutSeconds, MAX_QUEUE_DELAY_SECONDS) });
        }
        return Response.json({ ok: true });
      } catch (error) {
        return Response.json(String(error), { status: 500 });
      }
    };
  };
}

/**
 * Process a batch of messages from a CF Queue. For each message:
 * 1. Deserialize the payload
 * 2. Construct a Request with VQS headers
 * 3. Call the registered handler directly (no HTTP round-trip)
 * 4. If handler returns `{ timeoutSeconds }`: re-enqueue with capped delay
 * 5. On success: ack the message
 * 6. On error: retry the message
 */
type QueueHandlers = { flow: (req: Request) => Promise<Response>; step: (req: Request) => Promise<Response> };
/** Only `send` is used from the Queue binding — keep the constraint narrow so tests can provide minimal mocks. */
type Sendable = Pick<globalThis.Queue, "send">;
type QueueEnv = { WORKFLOW_QUEUE: Sendable; WORKFLOW_STEP_QUEUE: Sendable };

async function processOneMessage(
  msg: Message,
  data: QueueMessage,
  handlers: QueueHandlers,
  env: QueueEnv,
): Promise<void> {
  const queueName = data.queueName as ValidQueueName;
  const isStep = queueName.startsWith("__wkf_step_");
  const handler = isStep ? handlers.step : handlers.flow;
  const request = new Request(`http://localhost/.well-known/workflow/v1/${isStep ? "step" : "flow"}`, {
    method: "POST",
    headers: {
      ...data.headers,
      "content-type": "application/json",
      "x-vqs-queue-name": queueName,
      "x-vqs-message-id": data.messageId,
      "x-vqs-message-attempt": String(data.attempt),
    },
    body: new Uint8Array(data.body),
  });

  try {
    const response = await handler(request);
    const text = await response.text();
    if (!response.ok) {
      msg.retry();
      return;
    }
    if (await tryReenqueue(text, data, isStep, env)) {
      msg.ack();
      return;
    }
    msg.ack();
  } catch {
    msg.retry();
  }
}

async function tryReenqueue(text: string, data: QueueMessage, isStep: boolean, env: QueueEnv): Promise<boolean> {
  try {
    const body = JSON.parse(text);
    const timeoutSeconds = Number(body.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return false;
    const cfQueue = isStep ? env.WORKFLOW_STEP_QUEUE : env.WORKFLOW_QUEUE;
    await cfQueue.send(
      { ...data, attempt: data.attempt + 1 },
      { delaySeconds: Math.min(timeoutSeconds, MAX_QUEUE_DELAY_SECONDS) },
    );
    return true;
  } catch {
    return false;
  }
}

export async function processQueueBatch(batch: MessageBatch, handlers: QueueHandlers, env: QueueEnv): Promise<void> {
  for (const msg of batch.messages) {
    const parsed = QueueMessageSchema.safeParse(msg.body);
    if (!parsed.success) {
      msg.ack();
      continue;
    }
    await processOneMessage(msg, parsed.data, handlers, env);
  }
}
