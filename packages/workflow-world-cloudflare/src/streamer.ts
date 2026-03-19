import type { Streamer } from "@workflow/world";
import { monotonicFactory } from "ulid";
import type { WorkflowStreamDO } from "./stream-do.js";

const genChunkId = (() => {
  const ulid = monotonicFactory();
  return () => `chnk_${ulid()}` as const;
})();

function toArrayBuffer(chunk: string | Uint8Array): ArrayBuffer {
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk).buffer as ArrayBuffer;
  }
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
}

export interface CloudflareStreamer extends Streamer {
  close?(): Promise<void>;
}

export function createStreamer(streamDO: DurableObjectNamespace, db: D1Database): CloudflareStreamer {
  function getStub(name: string): DurableObjectStub & WorkflowStreamDO {
    const id = streamDO.idFromName(name);
    return streamDO.get(id) as DurableObjectStub & WorkflowStreamDO;
  }

  return {
    async writeToStream(name: string, _runId: string | Promise<string>, chunk: string | Uint8Array): Promise<void> {
      const runId = await _runId;
      const chunkId = genChunkId();

      // Ensure stream is indexed in D1
      await db
        .prepare("INSERT OR IGNORE INTO workflow_streams_index (streamName, runId) VALUES (?, ?)")
        .bind(name, runId)
        .run();

      const stub = getStub(name);
      await stub.writeChunk(chunkId, toArrayBuffer(chunk));
    },

    async writeToStreamMulti(
      name: string,
      _runId: string | Promise<string>,
      chunks: (string | Uint8Array)[],
    ): Promise<void> {
      if (chunks.length === 0) return;
      const runId = await _runId;

      await db
        .prepare("INSERT OR IGNORE INTO workflow_streams_index (streamName, runId) VALUES (?, ?)")
        .bind(name, runId)
        .run();

      const chunkData = chunks.map((c) => ({
        chunkId: genChunkId(),
        data: toArrayBuffer(c),
      }));

      const stub = getStub(name);
      await stub.writeChunks(chunkData);
    },

    async closeStream(name: string, _runId: string | Promise<string>): Promise<void> {
      await _runId;
      const chunkId = genChunkId();
      const stub = getStub(name);
      await stub.closeStream(chunkId);
    },

    async readFromStream(name: string, startIndex?: number): Promise<ReadableStream<Uint8Array>> {
      const stub = getStub(name);
      return await stub.readStream(startIndex);
    },

    async listStreamsByRunId(runId: string): Promise<string[]> {
      const result = await db
        .prepare("SELECT streamName FROM workflow_streams_index WHERE runId = ?")
        .bind(runId)
        .all<{ streamName: string }>();
      return result.results.map((r) => r.streamName);
    },
  };
}
