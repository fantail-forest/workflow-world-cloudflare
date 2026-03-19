/**
 * Lightweight polyfill for @vercel/queue's JsonTransport on Cloudflare Workers.
 *
 * The full @vercel/queue package pulls in @vercel/oidc and other Node.js-specific
 * dependencies that don't work in the workerd runtime. Since we only use
 * JsonTransport for serialization, this polyfill provides a compatible
 * implementation using standard Web APIs.
 */

function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  async function read(): Promise<Uint8Array> {
    const { done, value } = await reader.read();
    if (done) {
      let totalLength = 0;
      for (const c of chunks) totalLength += c.length;
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const c of chunks) {
        result.set(c, offset);
        offset += c.length;
      }
      return result;
    }
    chunks.push(value);
    return read();
  }
  return read();
}

export class DuplicateMessageError extends Error {
  constructor(message?: string) {
    super(message ?? "Duplicate message");
    this.name = "DuplicateMessageError";
  }
}

export class QueueClient {
  constructor(_options?: unknown) {
    throw new Error(
      "QueueClient is not available on Cloudflare Workers. " + "Use Cloudflare Queues via the env bindings instead.",
    );
  }
}

export class JsonTransport {
  contentType = "application/json";
  private replacer?: (key: string, value: unknown) => unknown;
  private reviver?: (key: string, value: unknown) => unknown;

  constructor(
    options: {
      replacer?: (key: string, value: unknown) => unknown;
      reviver?: (key: string, value: unknown) => unknown;
    } = {},
  ) {
    this.replacer = options.replacer;
    this.reviver = options.reviver;
  }

  serialize(value: unknown): Uint8Array {
    const json = JSON.stringify(value, this.replacer);
    return new TextEncoder().encode(json);
  }

  async deserialize(stream: ReadableStream<Uint8Array>): Promise<unknown> {
    const buffer = await streamToBuffer(stream);
    const text = new TextDecoder().decode(buffer);
    return JSON.parse(text, this.reviver);
  }
}
