import { DurableObject } from "cloudflare:workers";

interface ChunkRow extends Record<string, SqlStorageValue> {
  chunkId: string;
  data: ArrayBuffer;
  eof: number;
  createdAt: string;
}

/** Returns true if the pull loop should stop (chunk enqueued or stream closed). */
function dispatchChunk(row: ChunkRow, controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  if (row.eof) {
    controller.close();
    return true;
  }
  const bytes = new Uint8Array(row.data);
  if (bytes.byteLength > 0) {
    controller.enqueue(bytes);
    return true;
  }
  return false;
}

/**
 * Durable Object for real-time stream delivery.
 *
 * Each stream gets its own DO instance. Chunks are persisted in the DO's
 * internal SQLite and readers are notified in real-time via internal signaling.
 */
export class WorkflowStreamDO extends DurableObject {
  private readerResolve: (() => void) | null = null;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          chunkId TEXT PRIMARY KEY,
          data BLOB NOT NULL,
          eof INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    });
  }

  private notifyReader(): void {
    if (this.readerResolve) {
      this.readerResolve();
      this.readerResolve = null;
    }
  }

  async writeChunk(chunkId: string, data: ArrayBuffer): Promise<void> {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO chunks (chunkId, data, eof) VALUES (?, ?, 0)", chunkId, data);
    this.notifyReader();
  }

  async writeChunks(chunks: Array<{ chunkId: string; data: ArrayBuffer }>): Promise<void> {
    for (const chunk of chunks) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO chunks (chunkId, data, eof) VALUES (?, ?, 0)",
        chunk.chunkId,
        chunk.data,
      );
    }
    this.notifyReader();
  }

  async closeStream(chunkId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO chunks (chunkId, data, eof) VALUES (?, ?, 1)",
      chunkId,
      new ArrayBuffer(0),
    );
    this.notifyReader();
  }

  async readStream(startIndex?: number): Promise<ReadableStream<Uint8Array>> {
    const self = this;
    let lastChunkId = "";
    let offset = startIndex ?? 0;

    const fetchAndDispatch = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
      const rows = self.ctx.storage.sql
        .exec<ChunkRow>("SELECT chunkId, data, eof FROM chunks WHERE chunkId > ? ORDER BY chunkId", lastChunkId)
        .toArray();
      for (const row of rows) {
        lastChunkId = row.chunkId;
        if (offset > 0) {
          offset--;
          continue;
        }
        if (dispatchChunk(row, controller)) return true;
      }
      return false;
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          if (fetchAndDispatch(controller)) return;
          // No new chunks -- wait for notification
          await new Promise<void>((resolve) => {
            self.readerResolve = resolve;
          });
        }
      },
    });
  }

  async getChunkCount(): Promise<number> {
    const result = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM chunks").toArray();
    return result[0]?.count ?? 0;
  }
}
