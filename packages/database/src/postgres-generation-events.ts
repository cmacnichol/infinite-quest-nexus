import pg from "pg";
import type {
  GenerationChanged,
  GenerationEventSource,
  GenerationEventSubscription
} from "../../application/src/index.js";
import { logger as defaultLogger } from "../../logger/src/index.js";
import type { DatabasePool } from "./pool.js";

const { Client } = pg;

export const GENERATION_CHANGED_CHANNEL = "infinitequest_generation_changed_v1";

const MAX_NOTIFICATION_BYTES = 512;
const MAX_VERSION_BYTES = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ListenerNotification = Readonly<{
  channel: string;
  payload?: string;
}>;

type ListenerClient = Readonly<{
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (notification: ListenerNotification) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  removeListener(event: "notification", listener: (notification: ListenerNotification) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
}>;

type EventLogger = Readonly<{
  info(fields: Record<string, unknown>): unknown;
  warn(fields: Record<string, unknown>): unknown;
}>;

export type PostgresGenerationEventSource = GenerationEventSource & Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
}>;

export type PostgresGenerationEventSourceOptions = Readonly<{
  createClient?: () => ListenerClient;
  logger?: EventLogger;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  random?: () => number;
}>;

type PendingRead = (result: IteratorResult<GenerationChanged>) => void;

class InMemoryGenerationEventSubscription implements GenerationEventSubscription {
  readonly scope: Readonly<{ ownerUserId: string; campaignId: string; jobId: string }>;
  private readonly onClose: () => void;
  private readonly queue: GenerationChanged[] = [];
  private readonly pendingReads: PendingRead[] = [];
  private closed = false;

  constructor(
    scope: Readonly<{ ownerUserId: string; campaignId: string; jobId: string }>,
    onClose: () => void
  ) {
    this.scope = scope;
    this.onClose = onClose;
  }

  [Symbol.asyncIterator](): AsyncIterator<GenerationChanged> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<GenerationChanged>>((resolve) => {
          this.pendingReads.push(resolve);
        });
      }
    };
  }

  push(change: GenerationChanged): void {
    if (this.closed) return;
    const pending = this.pendingReads.shift();
    if (pending) {
      pending({ done: false, value: change });
      return;
    }
    this.queue.push(change);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.onClose();
    for (const pending of this.pendingReads.splice(0)) {
      pending({ done: true, value: undefined });
    }
  }
}

function validatedNotification(
  notification: ListenerNotification,
  logIgnored: (reason: string, payloadBytes: number) => void
): GenerationChanged | null {
  if (notification.channel !== GENERATION_CHANGED_CHANNEL) return null;
  const payload = notification.payload ?? "";
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes === 0 || payloadBytes > MAX_NOTIFICATION_BYTES) {
    logIgnored("payload_size", payloadBytes);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    logIgnored("invalid_json", payloadBytes);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logIgnored("invalid_shape", payloadBytes);
    return null;
  }
  const fields = parsed as Record<string, unknown>;
  if (typeof fields.jobId !== "string" || !UUID_PATTERN.test(fields.jobId)) {
    logIgnored("invalid_job_id", payloadBytes);
    return null;
  }
  if (typeof fields.version !== "string"
      || Buffer.byteLength(fields.version, "utf8") === 0
      || Buffer.byteLength(fields.version, "utf8") > MAX_VERSION_BYTES) {
    logIgnored("invalid_version", payloadBytes);
    return null;
  }
  return Object.freeze({ jobId: fields.jobId, version: fields.version });
}

export function createPostgresGenerationEventSource(
  pool: DatabasePool,
  databaseUrl: string,
  options: PostgresGenerationEventSourceOptions = {}
): PostgresGenerationEventSource {
  const createClient = options.createClient ?? (() => new Client({
    connectionString: databaseUrl,
    application_name: "infinite-quest-generation-events"
  }) as unknown as ListenerClient);
  const eventLogger = options.logger ?? defaultLogger;
  const reconnectBaseDelayMs = Math.max(10, options.reconnectBaseDelayMs ?? 100);
  const reconnectMaxDelayMs = Math.max(reconnectBaseDelayMs, options.reconnectMaxDelayMs ?? 5_000);
  const random = options.random ?? Math.random;
  const subscriptionsByJob = new Map<string, Set<InMemoryGenerationEventSubscription>>();

  let started = false;
  let closing = false;
  let startPromise: Promise<void> | null = null;
  let listener: ListenerClient | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connecting = false;

  const logIgnored = (reason: string, payloadBytes: number): void => {
    eventLogger.warn({
      event: "generation_event_notification_ignored",
      reason,
      payloadBytes
    });
  };

  const onNotification = (notification: ListenerNotification): void => {
    const change = validatedNotification(notification, logIgnored);
    if (!change) return;
    for (const subscription of subscriptionsByJob.get(change.jobId) ?? []) {
      subscription.push(change);
    }
  };

  let connectListener: () => Promise<void>;

  const scheduleReconnect = (): void => {
    if (closing || !started || reconnectTimer) return;
    const exponential = Math.min(
      reconnectMaxDelayMs,
      reconnectBaseDelayMs * (2 ** Math.min(reconnectAttempt, 10))
    );
    const jittered = Math.max(10, Math.round(exponential * (0.75 + Math.min(1, Math.max(0, random())) * 0.5)));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectListener().catch(() => undefined);
    }, Math.min(reconnectMaxDelayMs, jittered));
    reconnectTimer.unref?.();
  };

  const detach = (client: ListenerClient): void => {
    client.removeListener("notification", onNotification);
    client.removeListener("error", onError);
    client.removeListener("end", onEnd);
  };

  const retire = (client: ListenerClient, reason: "error" | "end"): void => {
    if (listener !== client) return;
    listener = null;
    detach(client);
    eventLogger.warn({ event: "generation_event_listener_disconnected", reason });
    void client.end().catch(() => undefined);
    scheduleReconnect();
  };

  function onError(error: Error): void {
    const current = listener;
    if (!current) return;
    eventLogger.warn({
      event: "generation_event_listener_error",
      errorName: error.name || "Error"
    });
    retire(current, "error");
  }

  function onEnd(): void {
    const current = listener;
    if (current) retire(current, "end");
  }

  connectListener = async (): Promise<void> => {
    if (closing || !started || connecting || listener) return;
    connecting = true;
    const client = createClient();
    listener = client;
    client.on("notification", onNotification);
    client.on("error", onError);
    client.on("end", onEnd);
    try {
      await client.connect();
      if (closing || listener !== client) return;
      await client.query(`LISTEN ${GENERATION_CHANGED_CHANNEL}`);
      reconnectAttempt = 0;
      eventLogger.info({ event: "generation_event_listener_ready" });
    } catch (error) {
      if (listener === client) {
        listener = null;
        detach(client);
        await client.end().catch(() => undefined);
      }
      eventLogger.warn({
        event: "generation_event_listener_connect_failed",
        errorName: error instanceof Error ? error.name : "Error"
      });
      scheduleReconnect();
      throw error;
    } finally {
      connecting = false;
    }
  };

  const source: PostgresGenerationEventSource = {
    async start() {
      if (startPromise) return startPromise;
      if (closing) throw new Error("Generation event source is closed.");
      started = true;
      startPromise = connectListener();
      return startPromise;
    },

    async subscribe(scope) {
      if (!started || closing) throw new Error("Generation event source is not available.");
      const authorized = await pool.query<{ id: string }>(
        `SELECT id FROM generation_jobs
          WHERE id = $1 AND owner_user_id = $2 AND campaign_id = $3`,
        [scope.jobId, scope.ownerUserId, scope.campaignId]
      );
      if (!authorized.rows[0]) {
        throw new Error("Generation job was not found in the requested event scope.");
      }
      if (closing) throw new Error("Generation event source is not available.");

      let subscription!: InMemoryGenerationEventSubscription;
      subscription = new InMemoryGenerationEventSubscription(Object.freeze({ ...scope }), () => {
        const subscribers = subscriptionsByJob.get(scope.jobId);
        subscribers?.delete(subscription);
        if (subscribers?.size === 0) subscriptionsByJob.delete(scope.jobId);
      });
      const subscribers = subscriptionsByJob.get(scope.jobId) ?? new Set<InMemoryGenerationEventSubscription>();
      subscribers.add(subscription);
      subscriptionsByJob.set(scope.jobId, subscribers);
      return subscription;
    },

    async close() {
      if (closing) return;
      closing = true;
      started = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const subscriptions = [...subscriptionsByJob.values()].flatMap((entries) => [...entries]);
      await Promise.all(subscriptions.map((subscription) => subscription.close()));
      subscriptionsByJob.clear();
      const current = listener;
      listener = null;
      if (current) {
        detach(current);
        await current.end();
      }
    }
  };

  return source;
}
