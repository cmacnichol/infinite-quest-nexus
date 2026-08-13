import { GenerationWorkflowProtocolError } from "@infinite-quest/client-core";
import { generationStreamSnapshotSchema } from "@infinite-quest/contracts";
import { apiPath, normalizeBasePath } from "../api-url.js";
import type {
  EventSourceSessionExit,
  EventSourceSessionOptions,
  SnapshotSourceEvent
} from "./types.js";

type QueueItem =
  | SnapshotSourceEvent
  | { kind: "exit"; exit: EventSourceSessionExit }
  | { kind: "error"; error: Error };

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "discarded",
  "cancelled",
  "recoverable"
]);

export function generationStreamUrl(basePath: string, jobId: string): string {
  return apiPath(
    normalizeBasePath(basePath),
    `/generation-jobs/${encodeURIComponent(jobId)}/stream`
  );
}

export function createEventSourceSession(
  options: EventSourceSessionOptions
): AsyncGenerator<SnapshotSourceEvent, EventSourceSessionExit, void> {
  const queue: QueueItem[] = [];
  let resolveRead: ((item: QueueItem) => void) | null = null;
  let source: ReturnType<EventSourceSessionOptions["eventSourceFactory"]> | null = null;
  let settled = false;
  let cleaned = false;
  let closed = false;

  const enqueue = (item: QueueItem) => {
    const resolve = resolveRead;
    if (resolve) {
      resolveRead = null;
      resolve(item);
    } else {
      queue.push(item);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    source?.close();
  };
  const settle = (exit: EventSourceSessionExit, discardQueued = false) => {
    if (settled) return;
    settled = true;
    close();
    if (discardQueued) queue.length = 0;
    enqueue({ kind: "exit", exit });
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    close();
    queue.length = 0;
    enqueue({ kind: "error", error });
  };
  const onAbort = () => settle("aborted", true);
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (source) {
      source.onmessage = null;
      source.onerror = null;
    }
    close();
    options.signal.removeEventListener("abort", onAbort);
  };
  const read = (): Promise<QueueItem> => {
    const item = queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      resolveRead = resolve;
    });
  };

  async function* session(): AsyncGenerator<SnapshotSourceEvent, EventSourceSessionExit, void> {
    if (options.signal.aborted) return "aborted";
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (options.signal.aborted) {
        settle("aborted", true);
      } else {
        source = options.eventSourceFactory(options.url);
        source.onmessage = (event) => {
          if (settled) return;
          try {
            const parsedJson: unknown = JSON.parse(event.data);
            const parsed = generationStreamSnapshotSchema.safeParse(parsedJson);
            if (!parsed.success) {
              fail(new GenerationWorkflowProtocolError("invalid_snapshot", { cause: parsed.error }));
              return;
            }
            enqueue({ kind: "snapshot", snapshot: parsed.data });
            if (TERMINAL_STATUSES.has(parsed.data.status)) settle("terminal");
          } catch (cause) {
            fail(new GenerationWorkflowProtocolError("invalid_snapshot", { cause }));
          }
        };
        source.onerror = () => settle("stream_lost");
      }

      while (true) {
        const item = await read();
        if (item.kind === "snapshot") {
          yield item;
          continue;
        }
        if (item.kind === "error") throw item.error;
        return item.exit;
      }
    } finally {
      cleanup();
    }
  }

  const iterator = session();
  const originalReturn = iterator.return.bind(iterator);
  iterator.return = async (value: EventSourceSessionExit) => {
    settle("aborted", true);
    return originalReturn(value);
  };
  return iterator;
}
