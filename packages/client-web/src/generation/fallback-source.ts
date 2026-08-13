import type { GenerationSnapshotSource } from "@infinite-quest/client-core";
import { normalizeBasePath } from "../api-url.js";
import { createEventSourceSession, generationStreamUrl } from "./event-source.js";
import { createPollSession } from "./poll-source.js";
import type {
  BrowserGenerationSourceOptions,
  GenerationSourceEvent
} from "./types.js";

export function createBrowserGenerationSource(
  options: BrowserGenerationSourceOptions
): GenerationSnapshotSource {
  const basePath = normalizeBasePath(options.basePath);

  return {
    watch(jobId, signal): AsyncIterable<GenerationSourceEvent> {
      return watchGeneration(options, basePath, jobId, signal);
    }
  };
}

async function* watchGeneration(
  options: BrowserGenerationSourceOptions,
  basePath: string,
  jobId: string,
  signal: Parameters<GenerationSnapshotSource["watch"]>[1]
): AsyncGenerator<GenerationSourceEvent, void, void> {
  if (signal.aborted) return;
  if (options.eventSourceFactory === null) {
    yield* createPollSession(options, jobId, signal);
    return;
  }

  const authorization = await options.session.authorization();
  if (signal.aborted) return;
  if (Object.keys(authorization).length > 0) {
    yield* createPollSession(options, jobId, signal);
    return;
  }

  const session = createEventSourceSession({
    url: generationStreamUrl(basePath, jobId),
    signal,
    eventSourceFactory: options.eventSourceFactory
  });
  try {
    while (true) {
      const next = await session.next();
      if (!next.done) {
        yield next.value;
        continue;
      }
      if (next.value === "terminal" || next.value === "aborted") return;
      yield { kind: "degraded", reason: "stream_lost", consecutiveFailures: 1 };
      break;
    }
  } finally {
    await session.return("aborted");
  }

  if (signal.aborted) return;
  yield* createPollSession(options, jobId, signal);
}
