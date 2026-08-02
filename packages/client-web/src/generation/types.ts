import type {
  AbortSignalLike,
  Clock,
  DelayScheduler,
  GenerationSnapshotSource,
  GenerationSourceEvent,
  SessionPort
} from "@infinite-quest/client-core";
import type { GenerationApi } from "../api-client.js";

export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface VisibilitySource {
  isHidden(): boolean;
  waitUntilVisible(signal: AbortSignalLike): Promise<void>;
}

export interface BrowserGenerationSourceOptions {
  api: Pick<GenerationApi, "get">;
  basePath: string;
  session: Pick<SessionPort, "authorization">;
  clock: Clock;
  delay: DelayScheduler;
  visibility: VisibilitySource;
  eventSourceFactory: EventSourceFactory | null;
  random: () => number;
}

export type SnapshotSourceEvent = Extract<GenerationSourceEvent, { kind: "snapshot" }>;
export type EventSourceSessionExit = "terminal" | "stream_lost" | "aborted";

export interface EventSourceSessionOptions {
  url: string;
  signal: AbortSignalLike;
  eventSourceFactory: EventSourceFactory;
}

export interface PollSessionOptions {
  api: Pick<GenerationApi, "get">;
  clock: Clock;
  delay: DelayScheduler;
  visibility: VisibilitySource;
  random: () => number;
}

export type { GenerationSnapshotSource, GenerationSourceEvent };
