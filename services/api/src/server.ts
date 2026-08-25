import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { z } from "zod";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import type {
  GenerationApplication,
  GenerationChanged,
  GenerationEventSource,
  GenerationEventSubscription,
  IllustrationApplication,
  MemoryApplication
} from "../../../packages/application/src/index.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { createLoggerOptions, logger } from "../../../packages/logger/src/index.js";
import { infiniteWorldsImportRequestSchema, storyImportPreviewRequestSchema } from "../../../packages/contracts/src/imports.js";
import { campaignEmbeddingConfigSchema, memoryContextQuerySchema } from "../../../packages/contracts/src/memory.js";
import {
  campaignBranchSchema,
  campaignRuntimeStateUpdateSchema,
  campaignRewindSchema,
  generationRequestSchema,
  generationRetryLatestRequestSchema,
  generationJobSnapshotSchema,
  generationStreamSnapshotSchema,
  PUBLIC_GENERATION_FAILURE_CODE,
  PUBLIC_GENERATION_FAILURE_MESSAGE,
  illustrationConfigSchema,
  illustrationRequestSchema,
  illustrationSegmentImageRequestSchema,
  illustrationSegmentRequestSchema,
  illustrationBackfillPreviewSchema,
  illustrationBackfillRequestSchema,
  assetSelectionSchema,
  worldCoverRequestSchema,
  playerCampaignConfigSchema,
  providerProfileInputSchema,
  providerProfileUpdateSchema,
  providerTextRequestSchema,
  turnInputClassificationRequestSchema
} from "../../../packages/contracts/src/generation.js";
import {
  campaignCreateSchema,
  campaignCharacterProfileUpdateSchema,
  campaignUpdateSchema,
  campaignWorldMigrationSchema,
  playableCharacterGenerationRequestSchema,
  characterProfileOrganizationRequestSchema,
  playableCharacterGenerationPreviewRequestSchema,
  playableCharacterGenerationPreviewResponseSchema,
  resourceDeleteSchema,
  worldCreateSchema,
  worldGenerationPreviewRequestSchema,
  worldDraftUpdateSchema,
  worldForkSchema,
  worldImportRequestSchema,
  worldPublishSchema,
  worldListResponseSchema,
  worldVersionDeleteSchema,
  worldStatusUpdateSchema
} from "../../../packages/contracts/src/world-library.js";
import { apiErrorEnvelopeSchema } from "../../../packages/contracts/src/http.js";
import {
  campaignBranchResponseSchema,
  campaignCreateResponseSchema,
  campaignListResponseSchema,
  campaignRewindResponseSchema,
  campaignRuntimeStateResponseSchema,
  campaignSyncStatusSchema,
  generationActionResponseSchema,
  generationEnqueueResponseSchema,
  generationResultSchema,
  metaResponseSchema,
  playableCharacterListResponseSchema,
  providerListResponseSchema,
  sessionResponseSchema,
  syncStatusRequestSchema,
  turnInputClassificationResponseSchema,
  turnListResponseSchema,
  turnPageRequestSchema,
  userProfileResponseSchema,
  worldCreateResponseSchema
} from "../../../packages/contracts/src/client-api.js";
import { providerTransportErrorDetails } from "../../../packages/story-engine/src/providers.js";
import { formatNarrationParagraphs } from "../../../packages/story-engine/src/narration-formatting.js";
import { readTurnPage } from "../../../packages/database/src/play-loop-read-repository.js";
import { createWorldShareLinkService } from "../../../packages/database/src/world-share-repository.js";
import { readReadableCampaignExport } from "../../../packages/database/src/readable-campaign-export-repository.js";
import { createPostgresTurnCorrectionRepository } from "../../../packages/database/src/turn-correction-repository.js";
import { renderReadableCampaignExport } from "../../../packages/story-engine/src/readable-campaign-export.js";
import { createTurnCorrectionApplication, TurnCorrectionApplicationError } from "../../../packages/application/src/turn-corrections/index.js";
import { acceptedTurnCorrectionRequestSchema } from "../../../packages/contracts/src/turn-corrections.js";
import { userProfileUpdateSchema } from "../../../packages/contracts/src/users.js";
import { assetListQuerySchema, assetMetadataUpdateSchema } from "../../../packages/contracts/src/assets.js";
import {
  promptTemplateKeySchema,
  promptTemplateOverrideSchema
} from "../../../packages/contracts/src/prompt-library.js";
import {
  campaignTransferCommitRequestSchema,
  campaignTransferPreviewRequestSchema
} from "../../../packages/contracts/src/campaign-transfer.js";
import { previewPortableLegacyStory } from "./portable-legacy-story-import-route.js";
import type { InfiniteWorldsImportProviderCollaborators } from "../../runtime/src/infinite-worlds-provider-collaborators.js";
import { createMemoryApplicationAdapter } from "./memory-application-adapter.js";
import {
  bindAssetMetadataHttpIngress,
  bindTurnAssetSelectionHttpIngress,
  bindWorldAssetSelectionHttpIngress,
  mapLegacyTurnAssetSelectionHttpResult,
  mapLegacyWorldAssetSelectionHttpResult
} from "../../../packages/application/src/assets/index.js";
import { toAssetServerStableReplayKey } from "../../../packages/application/src/assets/http-compatibility.js";
import { bindPrivateBoundedStreamLimits } from "../../../packages/application/src/assets/private-secure-storage.js";
import {
  createOwnerBoundPortableWorldApplicationPort,
  createWorldCampaignApplicationAdapter
} from "./world-campaign-application-adapter.js";
import type { FilesystemAssetStore } from "../../runtime/src/filesystem-asset-store.js";
import type { ProviderApiTransportAdapter } from "./provider-application-adapter.js";
import { createGenerationApplicationAdapter } from "./generation-application-adapter.js";
import { createGenerationRouteLifecycle, type GenerationLifecycleLogContext } from "./generation-route-lifecycle.js";
import { safeTurnInput } from "./turn-input-safety.js";
import { applicationMetadata } from "./app-metadata.js";
import { installRequestSecurity } from "./request-security.js";
import { registerSystemImportGate } from "./system-import-gate.js";
import { registerSystemArchiveRoutes } from "./system-archive-routes.js";
import { registerArchiveRoutes } from "./archive-routes.js";
import { createApiAssetComposition } from "../../runtime/src/api-asset-composition.js";
import type { ApiAssetComposition } from "../../runtime/src/api-asset-composition.js";
import {
  createApiSystemArchiveComposition,
  type ApiSystemArchiveComposition,
} from "../../runtime/src/system-archive-composition.js";
import {
  createApiCampaignArchiveAssetReader,
  createApiPortableImportExportComposition,
  type ApiPortableImportExportComposition,
  type ApiPortableImportExportCompositionOptions,
} from "../../runtime/src/api-portable-import-export-composition.js";
import { createAssetDeliveryStream } from "./asset-route-stream.js";
import { importPortableWorldJson, previewPortableWorldJson } from "./portable-world-import-route.js";
import {
  importPortableInfiniteWorlds,
  previewPortableInfiniteWorlds,
} from "./portable-infinite-worlds-import-route.js";
import {
  bindImportProgressLookup,
  mapImportProgressHttpResult,
} from "../../../packages/application/src/imports/index.js";

export type BuildServerOptions = {
  config: RuntimeConfig;
  pool: DatabasePool;
  generation: GenerationApplication;
  illustration: IllustrationApplication;
  memory: MemoryApplication;
  generationEvents: GenerationEventSource;
  worldCampaign: import("../../../packages/application/src/world-campaign/index.js").WorldCampaignApplication;
  providers: ProviderApiTransportAdapter;
  infiniteWorldsProviders: InfiniteWorldsImportProviderCollaborators;
  createApiAssets?: (pool: DatabasePool, roots: Readonly<{ archiveRoot: string; assetRoot: string }>) => Promise<ApiAssetComposition>;
  createApiPortable?: (options: ApiPortableImportExportCompositionOptions) => Promise<ApiPortableImportExportComposition>;
  createApiSystemArchive?: (options: Readonly<{
    pool: DatabasePool;
    config: RuntimeConfig;
    storage: Pick<ApiAssetComposition, "storage">["storage"];
  }>) => ApiSystemArchiveComposition;
};

const uuidSchema = z.uuid();
const worldShareCreateSchema = z.object({
  worldVersionId: z.uuid(),
  expiresInSeconds: z.coerce.number().int().min(300).max(2_592_000).default(604_800)
}).strict();
const worldShareTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const VITE_HASHED_STATIC_ASSET_PATTERN = /(?:^|[\\/])assets[\\/][^\\/]+-[A-Za-z0-9_-]{8,}\.[^\\/]+$/u;
let lastWorldGenerationProgressCleanupAt = 0;

function setStaticCacheHeader(reply: { header(name: string, value: string): unknown }, filePath: string): void {
  const isHtml = filePath.toLowerCase().endsWith(".html");
  reply.header(
    "Cache-Control",
    !isHtml && VITE_HASHED_STATIC_ASSET_PATTERN.test(filePath)
      ? "public, max-age=31536000, immutable"
      : "no-cache"
  );
}

function assetStableReplayKey(route: string, value: unknown): ReturnType<typeof toAssetServerStableReplayKey> {
  const digest = createHash("sha256").update(JSON.stringify({ route, value })).digest("hex");
  return toAssetServerStableReplayKey(`asset-http:${route}:${digest}`);
}

function assetIdempotencyHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
  const header = headers["idempotency-key"];
  if (Array.isArray(header)) throw Object.assign(new Error("idempotency_header_invalid"), { statusCode: 400 });
  return header;
}

function assetHttpIdempotency(
  headers: Record<string, string | string[] | undefined>,
  route: string,
  value: unknown,
) {
  const idempotencyHeader = assetIdempotencyHeader(headers);
  return {
    serverStableReplayKey: assetStableReplayKey(route, value),
    ...(idempotencyHeader === undefined ? {} : { idempotencyHeader })
  };
}

function assetDeliveryLimits(maximumBytes: number) {
  return bindPrivateBoundedStreamLimits({
    maximumBytes,
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  });
}

function isSafeAppNavigation(url: string): boolean {
  const rawPath = url.split(/[?#]/u, 1)[0] ?? "";
  if (!rawPath.startsWith("/app/")) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (pathname.includes("\\") || pathname.includes("\0")) return false;
  if (pathname === "/app/assets" || pathname.startsWith("/app/assets/")) return false;
  const segments = pathname.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  const finalSegment = segments.at(-1) ?? "";
  return finalSegment === "" || !finalSegment.includes(".");
}

function statusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const value = Number((error as { statusCode: unknown }).statusCode);
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  if (typeof error === "object" && error !== null && "issues" in error) return 400;
  if (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "22P02") return 400;
  return 500;
}

function errorDetails(error: unknown): { name: string; message: string; code?: string; issues?: unknown; details?: unknown } {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code: unknown }).code === "22P02") {
    return { name: "InvalidUuidError", message: "The provided ID is not a valid UUID." };
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    const issues = "issues" in error ? (error as Error & { issues?: unknown }).issues : undefined;
    const details = "details" in error ? (error as Error & { details?: unknown }).details : undefined;
    return {
      name: error.name || "Error",
      message: error.message,
      ...(code ? { code } : {}),
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details })
    };
  }
  return { name: "Error", message: String(error) };
}

function safeErrorDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
    if ((normalized.includes("path") && normalized !== "path") || normalized.includes("rawpayload")) return [];
    if (Array.isArray(child)) {
      return [[key, child.map((entry) => entry && typeof entry === "object" ? safeErrorDetails(entry) : entry)]];
    }
    if (child && typeof child === "object") return [[key, safeErrorDetails(child)]];
    return [[key, child]];
  }));
}

function exposeError(error: unknown, code: number): boolean {
  return code < 500 || (typeof error === "object" && error !== null && "expose" in error && (error as { expose?: unknown }).expose === true);
}

function safeLogErrorCode(value: unknown, fallback = "unclassified_error"): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

function errorCodeFrom(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function parseResponseProjection<TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) Object.assign(error, { statusCode: 500 });
    throw error;
  }
}

function generationPublicError(value: unknown): { errorCode: null | typeof PUBLIC_GENERATION_FAILURE_CODE; errorMessage: null | typeof PUBLIC_GENERATION_FAILURE_MESSAGE } {
  const status = typeof value === "object" && value !== null && "status" in value
    ? (value as { status?: unknown }).status
    : undefined;
  if (["failed", "recoverable", "cancelled", "discarded"].includes(String(status))) {
    return { errorCode: PUBLIC_GENERATION_FAILURE_CODE, errorMessage: PUBLIC_GENERATION_FAILURE_MESSAGE };
  }
  return { errorCode: null, errorMessage: null };
}

function generationSnapshot(value: unknown) {
  return parseResponseProjection(generationJobSnapshotSchema, { ...value as object, ...generationPublicError(value) });
}

function generationStreamSnapshot(value: unknown) {
  return parseResponseProjection(generationStreamSnapshotSchema, { ...value as object, ...generationPublicError(value) });
}

const GENERATION_STREAM_RECONCILIATION_MS = 15_000;
const TERMINAL_GENERATION_STATUSES = new Set(["completed", "failed", "recoverable", "discarded", "cancelled"]);

async function generationStreamWakeup(
  pendingHint: Promise<IteratorResult<GenerationChanged>>
): Promise<Readonly<{ kind: "hint"; result: IteratorResult<GenerationChanged> }> | Readonly<{ kind: "reconcile" }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reconciliation = new Promise<Readonly<{ kind: "reconcile" }>>((resolveWakeup) => {
    timer = setTimeout(() => resolveWakeup({ kind: "reconcile" }), GENERATION_STREAM_RECONCILIATION_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      pendingHint.then((result) => ({ kind: "hint" as const, result })),
      reconciliation
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function generationLifecycleLogContext(
  pool: DatabasePool,
  ownerUserId: string,
  generationJobId: string
): Promise<GenerationLifecycleLogContext | null> {
  const result = await pool.query<GenerationLifecycleLogContext>(
    `SELECT id AS "generationJobId", campaign_id AS "campaignId", provider_profile_id AS "providerProfileId",
            expected_turn_number AS "expectedTurnNumber", operation_kind AS "operationKind", attempts AS "jobAttempt"
       FROM generation_jobs WHERE id = $1 AND owner_user_id = $2`,
    [generationJobId, ownerUserId]
  );
  return result.rows[0] || null;
}

export async function buildServer({
  config,
  pool,
  generation,
  illustration,
  memory,
  generationEvents,
  worldCampaign,
  providers,
  infiniteWorldsProviders,
  createApiAssets = createApiAssetComposition,
  createApiPortable = createApiPortableImportExportComposition,
  createApiSystemArchive = createApiSystemArchiveComposition,
}: BuildServerOptions): Promise<FastifyInstance> {
  const illustrationTurnScope = async (turnId: string) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await pool.query<{ campaign_id: string }>(
      "SELECT campaign_id FROM turns WHERE id = $1 AND owner_user_id = $2",
      [turnId, ownerUserId]
    );
    const campaignId = result.rows[0]?.campaign_id;
    if (!campaignId) throw Object.assign(new Error("Turn not found."), { statusCode: 404 });
    return { ownerUserId, campaignId, turnId };
  };
  const illustrationSegmentScope = async (segmentId: string) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await pool.query<{ campaign_id: string; turn_id: string }>(
      `SELECT campaign_id, turn_id FROM turn_illustration_segments
        WHERE id = $1 AND owner_user_id = $2`,
      [segmentId, ownerUserId]
    );
    const segment = result.rows[0];
    if (!segment?.turn_id) throw Object.assign(new Error("Illustration segment not found."), { statusCode: 404 });
    return { ownerUserId, campaignId: segment.campaign_id, turnId: segment.turn_id, segmentId };
  };
  const app = Fastify({
    logger: createLoggerOptions(),
    bodyLimit: config.security.apiDefaultBodyLimitBytes,
    trustProxy: config.security.trustProxyHops,
    requestIdHeader: "x-correlation-id",
    genReqId: () => crypto.randomUUID()
  });
  const memoryAdapter = createMemoryApplicationAdapter(pool, memory);
  const turnCorrections = createTurnCorrectionApplication({
    corrections: createPostgresTurnCorrectionRepository(pool, { memory: memory.generation })
  });
  const generationAdapter = createGenerationApplicationAdapter(generation);
  const worldCampaignAdapter = createWorldCampaignApplicationAdapter(worldCampaign);
  const resolveWorldCampaignOwnerScope = async () => worldCampaignAdapter.ownerScope(await initialOwnerId(pool));
  const resolveWorldScope = async (worldId: string) => worldCampaignAdapter.worldScope(
    (await resolveWorldCampaignOwnerScope()).ownerUserId,
    worldId
  );
  const resolveCampaignScope = async (campaignId: string) => worldCampaignAdapter.campaignScope(
    (await resolveWorldCampaignOwnerScope()).ownerUserId,
    campaignId
  );
  const portableWorldApplication = createOwnerBoundPortableWorldApplicationPort(
    worldCampaignAdapter,
    resolveWorldCampaignOwnerScope
  );
  const generationLifecycle = createGenerationRouteLifecycle({
    readContext: (ownerUserId, generationJobId) => generationLifecycleLogContext(pool, ownerUserId, generationJobId),
    logger
  });

  app.setErrorHandler((error, request, reply) => {
    const code = statusCode(error);
    const details = errorDetails(error);
    const exposed = exposeError(error, code);
    const transport = providerTransportErrorDetails(error);
    const exposedError = (details.name === "ArchiveError" || details.name === "OriginNotAllowedError") && details.code
      ? details.code
      : details.name;
    const providerErrorCode = transport?.timedOut ? "provider_request_timeout" : "provider_transport_error";
    if (transport) {
      request.log.error({
        correlationId: request.id,
        code,
        errorName: details.name,
        errorCode: providerErrorCode,
        providerCategory: transport.causeCategory,
        durationMs: transport.durationMs
      }, "request_failed");
    } else {
      request.log.error({ err: error, code }, "request_failed");
    }
    const payload = apiErrorEnvelopeSchema.parse({
      error: exposed ? (exposedError || "Provider request failed") : "Internal server error",
      message: transport
        ? `${transport.timedOut ? "The provider request timed out." : "The provider connection failed."} Correlation ID: ${request.id}.`
        : exposed ? `${details.message} Correlation ID: ${request.id}.` : "The request failed. Use the correlation ID to locate server diagnostics.",
      correlationId: request.id,
      ...(!exposed || details.code === undefined ? {} : { code: details.code }),
      details: transport
        ? { code: providerErrorCode, category: transport.causeCategory, retryable: true }
        : exposed ? safeErrorDetails(details.details) : {},
      ...(details.issues === undefined ? {} : { issues: details.issues })
    });
    void reply.code(code).send(payload);
  });

  installRequestSecurity(app, config);
  registerSystemImportGate(app, {
    pool,
    enabled: config.systemArchiveEnabled ?? false,
  });

  app.options("*", async (_request, reply) => {
    return reply.code(204).send();
  });

  await mkdir(config.assetStorageRoot, { recursive: true });
  await mkdir(config.archiveStorageRoot, { recursive: true });
  const assetStore: FilesystemAssetStore = { root: config.assetStorageRoot };
  const apiAssets = await createApiAssets(pool, {
    archiveRoot: config.archiveStorageRoot,
    assetRoot: config.assetStorageRoot
  });
  const apiSystemArchive = config.systemArchiveEnabled === true
    ? createApiSystemArchive({ pool, config, storage: apiAssets.storage })
    : undefined;
  const apiPortable = await createApiPortable({
    pool,
    config,
    memory: memory.generation,
    providers: infiniteWorldsProviders,
    leaseOwner: `api-portable-${crypto.randomUUID()}`,
    assetReader: createApiCampaignArchiveAssetReader(apiAssets),
  });
  app.addHook("onClose", async () => {
    await Promise.all([apiAssets.close(), apiPortable.close()]);
  });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.security.apiImportBodyLimitBytes,
      fieldSize: config.security.apiImportBodyLimitBytes
    }
  });
  if (apiSystemArchive) {
    await app.register(registerSystemArchiveRoutes, {
      enabled: true,
      application: apiSystemArchive.application,
      downloads: apiSystemArchive.downloads,
      resolveOwner: async () => ({ ownerUserId: await initialOwnerId(pool) }),
      limits: {
        chunkBytes: config.systemArchiveChunkBytes!,
        maximumUploadBytes: config.systemArchiveLimits.maxCompressedBytes,
        maximumDownloadBytes: config.systemArchiveLimits.maxCompressedBytes,
        downloadDeadlineMs: Math.max(60_000, config.workerLeaseSeconds * 4_000),
      },
    });
  }
  await app.register(registerArchiveRoutes, {
    pool,
    config,
    assetStore,
    memory: memory.generation,
    portable: apiPortable.portable,
    resolveOwner: async () => ({ ownerUserId: await initialOwnerId(pool) }),
  });
  await app.register(fastifyStatic, {
    root: config.legacyWebRoot,
    prefix: "/nexus/",
    index: ["index.html"],
    decorateReply: true,
    setHeaders: setStaticCacheHeader
  });
  await app.register(fastifyStatic, {
    root: resolve(process.cwd(), "node_modules/photoswipe/dist"),
    prefix: "/vendor/photoswipe/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "30d"
  });

  app.get("/", async (_request, reply) => reply.redirect("/nexus/", 308));
  app.get("/index.html", async (_request, reply) => reply.redirect("/nexus/", 308));
  app.get("/app", async (_request, reply) => reply.redirect("/app/", 308));

  // Story Player — clean URL for campaign gameplay
  const storyHtml = async () => {
    return readFile(resolve(config.legacyWebRoot, "story.html"), "utf8");
  };
  let storyHtmlCache: string | null = null;
  const cachedStoryHtml = async () => {
    storyHtmlCache ??= await storyHtml();
    return storyHtmlCache;
  };
  app.get("/story", async (_request, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(await cachedStoryHtml()));
  app.get("/story/:campaignId", async (_request, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(await cachedStoryHtml()));
  let nextHtmlCache: string | null = null;
  const cachedNextHtml = async () => {
    nextHtmlCache ??= await readFile(resolve(config.nextWebRoot, "index.html"), "utf8");
    return nextHtmlCache;
  };
  await app.register(async (appScope) => {
    appScope.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && isSafeAppNavigation(request.url)) {
        return reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-cache")
          .send(await cachedNextHtml());
      }
      const { method, url } = request.raw;
      return reply.code(404).send({
        message: `Route ${method}:${url} not found`,
        error: "Not Found",
        statusCode: 404
      });
    });
    await appScope.register(fastifyStatic, {
      root: config.nextWebRoot,
      prefix: "/",
      index: ["index.html"],
      decorateReply: false,
      setHeaders: setStaticCacheHeader
    });
  }, { prefix: "/app" });
  app.get("/health/live", async () => ({ status: "ok", role: config.role }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      const result = await pool.query<{ database_version: string; vector_version: string | null }>(
        `SELECT current_setting('server_version') AS database_version,
                (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version`
      );
      const row = result.rows[0];
      if (!row?.vector_version) return reply.code(503).send({ status: "not_ready", reason: "pgvector extension is unavailable" });
      return { status: "ready", databaseVersion: row.database_version, pgvectorVersion: row.vector_version };
    } catch (error) {
      requestLogError(reply, error);
      return reply.code(503).send({ status: "not_ready", reason: "database unavailable" });
    }
  });

  app.get("/api/v1/meta", async () => parseResponseProjection(metaResponseSchema, {
    application: applicationMetadata(),
    capabilities: { systemArchive: config.systemArchiveEnabled === true },
  }));

  app.get("/api/v1/dashboard/stats", async () => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return worldCampaignAdapter.run(() => worldCampaignAdapter.application.getDashboard(ownerScope));
  });

  app.get("/api/v1/session", async () => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    const user = await worldCampaignAdapter.run(() => worldCampaignAdapter.application.getSessionProfile(ownerScope));
    return parseResponseProjection(sessionResponseSchema, { user, authentication: "deferred" });
  });

  const sessionProfile = async () => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return worldCampaignAdapter.run(() => worldCampaignAdapter.application.getSessionProfile(ownerScope));
  };
  const updateSessionProfile = async (value: unknown) => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    const request = userProfileUpdateSchema.parse(value);
    return worldCampaignAdapter.run(() => worldCampaignAdapter.application.updateSessionProfile(ownerScope, request));
  };
  app.get("/api/v1/users/me", async () => ({ user: await sessionProfile() }));
  app.get("/api/v1/user/profile", async () => ({ user: await sessionProfile() }));

  app.patch("/api/v1/users/me/profile", async (request) => parseResponseProjection(userProfileResponseSchema, {
    user: await updateSessionProfile(request.body)
  }));
  app.put("/api/v1/users/me/profile", async (request) => ({
    user: await updateSessionProfile(request.body)
  }));
  app.patch("/api/v1/user/profile", async (request) => ({
    user: await updateSessionProfile(request.body)
  }));
  app.put("/api/v1/user/profile", async (request) => ({
    user: await updateSessionProfile(request.body)
  }));

  app.get("/api/v1/prompt-library", async (request) => {
    const query = z.object({ campaignId: z.uuid().optional() }).parse(request.query);
    return providers.listPromptLibrary(await initialOwnerId(pool), query.campaignId);
  });
  app.put("/api/v1/prompt-library/overrides", async (request) => ({
    library: await providers.savePromptOverride(
      await initialOwnerId(pool),
      (() => {
        const body = promptTemplateOverrideSchema.parse(request.body);
        return {
          key: body.key,
          content: body.content,
          scope: body.scope,
          ...(body.campaignId === undefined ? {} : { campaignId: body.campaignId })
        };
      })()
    )
  }));
  app.delete("/api/v1/prompt-library/overrides", async (request) => {
    const body = z.object({
      key: promptTemplateKeySchema,
      scope: z.enum(["application", "campaign"]),
      campaignId: z.uuid().optional()
    }).parse(request.body);
    return {
      library: await providers.resetPromptOverride(
        await initialOwnerId(pool),
        {
          key: body.key,
          scope: body.scope,
          ...(body.campaignId === undefined ? {} : { campaignId: body.campaignId })
        }
      )
    };
  });
  app.post("/api/v1/prompt-library/preview", async (request) => {
    const body = z.object({ key: promptTemplateKeySchema, content: z.string().trim().min(1).max(16_000) })
      .parse(request.body);
    return providers.previewPrompt(await initialOwnerId(pool), body);
  });

  app.get("/api/v1/providers", async () => parseResponseProjection(providerListResponseSchema, {
    providers: await providers.list(await initialOwnerId(pool))
  }));

  app.post("/api/v1/providers", async (request, reply) => {
    const input = providerProfileInputSchema.parse(request.body);
    const provider = await providers.create(await initialOwnerId(pool), input);
    return reply.code(201).send(provider);
  });

  app.get<{
    Params: { providerId: string };
    Querystring: { providerRole?: string };
  }>("/api/v1/providers/:providerId/models", async (request) => ({
    models: await providers.models(
      await initialOwnerId(pool),
      uuidSchema.parse(request.params.providerId),
      z.object({ providerRole: z.literal("embedding").optional() }).parse(request.query).providerRole
    )
  }));

  app.put<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/default", async (request) => (
    providers.setDefault(await initialOwnerId(pool), uuidSchema.parse(request.params.providerId))
  ));

  app.patch<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    providers.update(
      await initialOwnerId(pool),
      uuidSchema.parse(request.params.providerId),
      providerProfileUpdateSchema.parse(request.body)
    )
  ));

  app.post("/api/v1/provider-text/generate", async (request) => (
    providers.generateText(await initialOwnerId(pool), providerTextRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/providers/discover-models", async (request) => ({
    models: await providers.discoverModels(await initialOwnerId(pool), providerProfileInputSchema.parse(request.body))
  }));

  app.delete<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    providers.delete(await initialOwnerId(pool), uuidSchema.parse(request.params.providerId))
  ));

  app.post("/api/v1/imports/legacy-story/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => {
    const preview = await previewPortableLegacyStory({
      portable: apiPortable.portable,
      pool,
      owner: { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId },
      request: storyImportPreviewRequestSchema.parse(request.body),
      leaseOwner: `api-legacy-story-preview-${crypto.randomUUID()}`,
    });
    return preview.projection;
  });

  app.post("/api/v1/imports/world/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => (
    previewPortableWorldJson({
      portable: apiPortable.portable,
      owner: { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId },
      request: worldImportRequestSchema.parse(request.body),
      leaseOwner: `api-world-preview-${crypto.randomUUID()}`,
    }).then((preview) => ({ ...preview.projection, kind: "world" as const }))
  ));

  app.post("/api/v1/imports/world", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    const result = await importPortableWorldJson({
      portable: apiPortable.portable,
      owner: { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId },
      request: worldImportRequestSchema.parse(request.body),
      leaseOwner: `api-world-import-${crypto.randomUUID()}`,
    });
    return reply.code(result.duplicate ? 200 : 201).send(result.result);
  });

  app.post("/api/v1/imports/infinite-worlds/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => (
    previewPortableInfiniteWorlds({
      portable: apiPortable.portable,
      pool,
      owner: { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId },
      request: infiniteWorldsImportRequestSchema.parse(request.body),
      leaseOwner: `api-infinite-worlds-preview-${crypto.randomUUID()}`,
    })
  ));

  app.post("/api/v1/imports/infinite-worlds", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    const result = await importPortableInfiniteWorlds({
      portable: apiPortable.portable,
      progress: apiPortable.progress,
      pool,
      owner: { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId },
      request: infiniteWorldsImportRequestSchema.parse(request.body),
      leaseOwner: `api-infinite-worlds-import-${crypto.randomUUID()}`,
      diagnoseWorldGenerationFailure: infiniteWorldsProviders.diagnoseWorldGenerationFailure,
    });
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get<{ Querystring: { key?: string } }>("/api/v1/imports/progress", async (request, reply) => {
    const owner = { ownerUserId: (await resolveWorldCampaignOwnerScope()).ownerUserId };
    const lookup = bindImportProgressLookup(owner, String(request.query.key || ""));
    const result = mapImportProgressHttpResult(await apiPortable.progress.read(lookup));
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/api/v1/worlds", async () => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return parseResponseProjection(
      worldListResponseSchema,
      await worldCampaignAdapter.run(() => worldCampaignAdapter.application.listWorlds(ownerScope))
    );
  });

  app.post("/api/v1/worlds", async (request, reply) => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    const result = await worldCampaignAdapter.run(() => worldCampaignAdapter.application.createWorld(
      ownerScope,
      worldCreateSchema.parse(request.body)
    ));
    return reply.code(201).send(parseResponseProjection(worldCreateResponseSchema, result));
  });

  app.post("/api/v1/worlds/generate-preview", async (request) => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return worldCampaignAdapter.run(() => worldCampaignAdapter.application.generateWorldPreview(
      ownerScope,
      worldGenerationPreviewRequestSchema.parse(request.body)
    ));
  });

  app.get<{ Querystring: { key?: string } }>("/api/v1/worlds/generate-progress", async (request) => {
    const key = String(request.query.key || "").trim();
    if (!key) return { status: "unknown", phase: "unknown", progressPercent: 0, message: "" };
    const ownerScope = await resolveWorldCampaignOwnerScope();
    if (Date.now() - lastWorldGenerationProgressCleanupAt >= 60_000) {
      lastWorldGenerationProgressCleanupAt = Date.now();
      await worldCampaignAdapter.run(() => worldCampaignAdapter.application.deleteExpiredWorldGenerationProgress(
        ownerScope,
        new Date().toISOString()
      ));
    }
    const progress = await worldCampaignAdapter.run(() => worldCampaignAdapter.application.getWorldGenerationProgress({
      ...ownerScope,
      progressKey: key
    }));
    return progress || { status: "unknown", phase: "unknown", progressPercent: 0, message: "" };
  });

  app.post("/api/v1/worlds/playable-characters/generate-preview", async (request) => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return parseResponseProjection(
      playableCharacterGenerationPreviewResponseSchema,
      await worldCampaignAdapter.run(() => worldCampaignAdapter.application.generatePlayableCharacterPreview(
        ownerScope,
        playableCharacterGenerationPreviewRequestSchema.parse(request.body)
      ))
    );
  });

  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.getWorld(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId))
    ))
  ));

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.updateWorldDraft(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      worldDraftUpdateSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft/playable-characters/generate", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.generatePlayableCharacter(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      playableCharacterGenerationRequestSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft/playable-characters/organize", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.organizeWorldCharacterProfile(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      characterProfileOrganizationRequestSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/publish", async (request, reply) => {
    const result = await worldCampaignAdapter.run(async () => worldCampaignAdapter.application.publishWorld(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      worldPublishSchema.parse(request.body)
    ));
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.updateWorldStatus(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      worldStatusUpdateSchema.parse(request.body)
    ))
  ));

  app.delete<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.deleteWorld(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      resourceDeleteSchema.parse(request.body)
    ))
  ));

  app.delete<{ Params: { worldId: string; worldVersionId: string } }>("/api/v1/worlds/:worldId/versions/:worldVersionId", async (request) => (
    worldCampaignAdapter.run(async () => {
      const ownerScope = await resolveWorldCampaignOwnerScope();
      return worldCampaignAdapter.application.deleteWorldVersion(
        worldCampaignAdapter.worldVersionScope(
          ownerScope.ownerUserId,
          uuidSchema.parse(request.params.worldId),
          uuidSchema.parse(request.params.worldVersionId)
        ),
        worldVersionDeleteSchema.parse(request.body)
      );
    })
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/fork", async (request, reply) => {
    const result = await worldCampaignAdapter.run(async () => worldCampaignAdapter.application.forkWorld(
      await resolveWorldScope(uuidSchema.parse(request.params.worldId)),
      worldForkSchema.parse(request.body)
    ));
    return reply.code(201).send(result);
  });

  app.get<{ Params: { worldId: string }; Querystring: { worldVersionId?: string } }>("/api/v1/worlds/:worldId/export", async (request, reply) => {
    const versionId = request.query.worldVersionId ? uuidSchema.parse(request.query.worldVersionId) : undefined;
    return reply
      .header("content-disposition", 'attachment; filename="infinite-quest-world.json"')
      .send(await portableWorldApplication.exportWorld({
        worldId: uuidSchema.parse(request.params.worldId),
        ...(versionId === undefined ? {} : { worldVersionId: versionId })
      }));
  });

  const worldShares = createWorldShareLinkService(pool);
  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/share-links", async (request, reply) => {
    if (config.worldSharingEnabled !== true) return reply.code(404).send({ error: "World sharing is disabled." });
    return { shares: await worldShares.list(await initialOwnerId(pool), uuidSchema.parse(request.params.worldId)) };
  });
  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/share-links", async (request, reply) => {
    if (config.worldSharingEnabled !== true) return reply.code(404).send({ error: "World sharing is disabled." });
    const body = worldShareCreateSchema.parse(request.body);
    const created = await worldShares.create({
      ownerUserId: await initialOwnerId(pool),
      worldId: uuidSchema.parse(request.params.worldId),
      worldVersionId: body.worldVersionId,
      expiresAt: new Date(Date.now() + body.expiresInSeconds * 1000)
    });
    return created
      ? reply.code(201).send(created)
      : reply.code(404).send({ error: "The selected published world version was not found." });
  });
  app.delete<{ Params: { worldId: string; shareId: string } }>("/api/v1/worlds/:worldId/share-links/:shareId", async (request, reply) => {
    if (config.worldSharingEnabled !== true) return reply.code(404).send({ error: "World sharing is disabled." });
    const revoked = await worldShares.revoke(
      await initialOwnerId(pool),
      uuidSchema.parse(request.params.worldId),
      uuidSchema.parse(request.params.shareId)
    );
    return revoked ? reply.code(204).send() : reply.code(404).send({ error: "World share link not found." });
  });
  app.get<{ Params: { token: string } }>("/api/v1/world-shares/:token", async (request, reply) => {
    if (config.worldSharingEnabled !== true) return reply.code(404).send({ error: "World share link not found." });
    const redeemed = await worldShares.redeem(worldShareTokenSchema.parse(request.params.token));
    return redeemed ? redeemed : reply.code(404).send({ error: "World share link not found." });
  });

  app.get("/api/v1/campaigns", async () => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    return parseResponseProjection(
      campaignListResponseSchema,
      await worldCampaignAdapter.run(() => worldCampaignAdapter.application.listCampaigns(ownerScope))
    );
  });

  app.get<{ Params: { campaignId: string }; Querystring: { format?: string } }>("/api/v1/campaigns/:campaignId/readable-export", async (request, reply) => {
    const format = z.enum(["html", "markdown"]).default("html").parse(request.query.format);
    const projection = await readReadableCampaignExport(
      pool,
      await initialOwnerId(pool),
      uuidSchema.parse(request.params.campaignId)
    );
    if (!projection) return reply.code(404).send({ error: "Campaign not found." });
    const rendered = renderReadableCampaignExport(projection, format);
    return reply
      .type(rendered.contentType)
      .header("content-disposition", `attachment; filename="${rendered.filename}"`)
      .send(rendered.body);
  });

  app.get<{ Params: { worldVersionId: string } }>("/api/v1/world-versions/:worldVersionId/playable-characters", async (request) => (
    worldCampaignAdapter.run(async () => {
      const ownerScope = await resolveWorldCampaignOwnerScope();
      return parseResponseProjection(
        playableCharacterListResponseSchema,
        await worldCampaignAdapter.application.getWorldVersionPlayableCharacterSummary({
          ...ownerScope,
          worldVersionId: uuidSchema.parse(request.params.worldVersionId)
        })
      );
    })
  ));

  app.post("/api/v1/campaigns", async (request, reply) => {
    const ownerScope = await resolveWorldCampaignOwnerScope();
    const result = await worldCampaignAdapter.run(() => worldCampaignAdapter.application.createCampaign(
      ownerScope,
      campaignCreateSchema.parse(request.body)
    ));
    return reply.code(201).send(parseResponseProjection(campaignCreateResponseSchema, result));
  });

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.updateCampaign(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      campaignUpdateSchema.parse(request.body)
    ))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.getCampaignCharacterProfile(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId))
    ))
  ));

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.updateCampaignCharacterProfile(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      campaignCharacterProfileUpdateSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile/organize", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.organizeCampaignCharacterProfile(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      characterProfileOrganizationRequestSchema.parse(request.body)
    ))
  ));

  app.delete<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.deleteCampaign(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      resourceDeleteSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/migrate-world", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.migrateCampaignWorldVersion(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      campaignWorldMigrationSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world/preview", async (request) => (
    worldCampaignAdapter.run(async () => worldCampaignAdapter.application.previewCampaignWorldTransfer(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      campaignTransferPreviewRequestSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world", async (request, reply) => {
    const result = await worldCampaignAdapter.run(async () => worldCampaignAdapter.application.transferCampaignWorld(
      await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
      campaignTransferCommitRequestSchema.parse(request.body)
    ));
    return reply.code(result.reused ? 200 : 201).send(result);
  });

  app.get<{ Params: { campaignId: string }; Querystring: { before?: string; limit?: string } }>("/api/v1/campaigns/:campaignId/turns", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const pageRequest = turnPageRequestSchema.parse(request.query);
    const page = await readTurnPage(pool, ownerUserId, campaignId, pageRequest.before, pageRequest.limit ?? 50);
    const costs = await providers.application.getTurnCosts({
      ownerUserId,
      campaignId,
      turnIds: page.turns.map((turn) => turn.id)
    });
    return parseResponseProjection(turnListResponseSchema, {
      campaignId,
      turns: page.turns.map((turn) => ({
        ...turn,
        narration: formatNarrationParagraphs(turn.narration),
        reportedCost: costs.get(turn.id) || null
      })),
      nextCursor: page.nextCursor
    });
  });

  app.get<{ Params: { campaignId: string; turnId: string } }>("/api/v1/campaigns/:campaignId/turns/:turnId/correction", async (request, reply) => {
    const scope = {
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    };
    const correction = await turnCorrections.getEffectiveNarration(scope, uuidSchema.parse(request.params.turnId));
    return correction ?? reply.code(404).send({ error: "Turn not found." });
  });

  app.patch<{ Params: { campaignId: string; turnId: string } }>("/api/v1/campaigns/:campaignId/turns/:turnId/correction", async (request, reply) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const turnId = uuidSchema.parse(request.params.turnId);
    try {
      return await turnCorrections.correctNarration(
        { ownerUserId: await initialOwnerId(pool), campaignId },
        acceptedTurnCorrectionRequestSchema.parse({ ...(request.body as Record<string, unknown>), turnId })
      );
    } catch (error) {
      if (!(error instanceof TurnCorrectionApplicationError)) throw error;
      const code = error.kind === "not_found" ? 404
        : error.kind === "stale_state" || error.kind === "conflict" ? 409
          : 400;
      return reply.code(code).send({ error: error.reason, details: error.details });
    }
  });

  app.get<{ Params: { campaignId: string }; Querystring: { turnNumber?: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    worldCampaignAdapter.run(async () => parseResponseProjection(
      campaignRuntimeStateResponseSchema,
      await worldCampaignAdapter.application.getCampaignRuntimeState(
        await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
        request.query.turnNumber === undefined
          ? undefined
          : z.coerce.number().int().min(0).parse(request.query.turnNumber)
      )
    ))
  ));

  app.get<{ Params: { campaignId: string }; Querystring: { turnNumber: string } }>("/api/v1/campaigns/:campaignId/state/inspection", async (request) => (
    worldCampaignAdapter.run(async () => parseResponseProjection(
      campaignRuntimeStateResponseSchema,
      await worldCampaignAdapter.application.getCampaignRuntimeState(
        await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
        z.coerce.number().int().positive().parse(request.query.turnNumber),
        true
      )
    ))
  ));

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    worldCampaignAdapter.run(async () => parseResponseProjection(
      campaignRuntimeStateResponseSchema,
      await worldCampaignAdapter.application.updateCampaignRuntimeState(
        await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
        campaignRuntimeStateUpdateSchema.parse(request.body)
      )
    ))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/cost-summary", async (request) => (
    providers.application.getCampaignCostSummary({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    })
  ));

  app.get<{ Params: { campaignId: string }; Querystring: { since?: string } }>("/api/v1/campaigns/:campaignId/sync-status", async (request) => {
    const scope = await resolveCampaignScope(uuidSchema.parse(request.params.campaignId));
    const result = await worldCampaignAdapter.run(() => worldCampaignAdapter.application.getCampaignSyncStatus(
      scope,
      syncStatusRequestSchema.parse(request.query)
    ));
    return parseResponseProjection(campaignSyncStatusSchema, result);
  });
  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/player-config", async (request) => (
    worldCampaignAdapter.run(async () => {
      const scope = await resolveCampaignScope(uuidSchema.parse(request.params.campaignId));
      const state = await worldCampaignAdapter.application.getCampaignRuntimeState(scope);
      return worldCampaignAdapter.application.syncPlayerCampaignConfig(scope, {
        ...playerCampaignConfigSchema.parse(request.body),
        expectedStateRevision: state.revision
      });
    })
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/rewind", async (request) => (
    worldCampaignAdapter.run(async () => {
      const body = campaignRewindSchema.parse(request.body);
      const scope = await resolveCampaignScope(uuidSchema.parse(request.params.campaignId));
      const state = await worldCampaignAdapter.application.getCampaignRuntimeState(scope);
      return parseResponseProjection(
        campaignRewindResponseSchema,
        await worldCampaignAdapter.application.rewindCampaign(scope, {
          ...body,
          expectedCurrentTurnNumber: body.expectedCurrentTurnNumber ?? state.activeTurnNumber,
          expectedStateRevision: state.revision
        })
      );
    })
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/branch", async (request, reply) => (
    reply.code(201).send(
      await worldCampaignAdapter.run(async () => parseResponseProjection(
        campaignBranchResponseSchema,
        await worldCampaignAdapter.application.branchCampaign(
          await resolveCampaignScope(uuidSchema.parse(request.params.campaignId)),
          campaignBranchSchema.parse(request.body)
        )
      ))
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/turn-input/classify", async (request) => {
    const body = turnInputClassificationRequestSchema.parse(request.body);
    return parseResponseProjection(turnInputClassificationResponseSchema, await providers.application.classifyTurnIntent({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId),
      text: body.text,
      ...(body.preferredFallback === undefined ? {} : { preferredFallback: body.preferredFallback })
    }));
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations", async (request, reply) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const body = generationRequestSchema.parse(request.body);
    safeTurnInput(body.action);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    const job = await generationAdapter.enqueueGeneration(ownerScope, campaignId, body);
    return reply.code(job.duplicate ? 200 : 202).send(parseResponseProjection(generationEnqueueResponseSchema, job));
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations/retry-latest", async (request, reply) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const body = generationRetryLatestRequestSchema.parse(request.body);
    safeTurnInput(body.action);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    const job = await generationAdapter.enqueueLatestReplacement(ownerScope, campaignId, body);
    return reply.code(job.duplicate ? 200 : 202).send(parseResponseProjection(generationEnqueueResponseSchema, job));
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId", async (request) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    return generationSnapshot(await generationAdapter.getGenerationJob(ownerScope, jobId));
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/stream", async (request, reply) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    const streamStartedAt = Date.now();
    let snapshotsSent = 0;
    let finalStatus = "client_closed";
    let isClosed = false;
    let subscription: GenerationEventSubscription | undefined;
    let closePromise: Promise<void> | undefined;
    const closeSubscription = (): Promise<void> => {
      if (!subscription) return Promise.resolve();
      closePromise ??= subscription.close();
      return closePromise;
    };
    const markClientClosed = (): void => {
      isClosed = true;
      void closeSubscription();
    };
    request.raw.on("close", markClientClosed);
    reply.raw.on("close", markClientClosed);

    const firstJob = generationStreamSnapshot(await generationAdapter.getGenerationJob(ownerScope, jobId));
    subscription = await generationEvents.subscribe({
      ownerUserId: ownerScope.ownerUserId,
      campaignId: firstJob.campaignId,
      jobId
    });
    if (isClosed) await closeSubscription();
    let job = generationStreamSnapshot(await generationAdapter.getGenerationJob(ownerScope, jobId));
    if (job.campaignId !== firstJob.campaignId) {
      await closeSubscription();
      throw Object.assign(new Error("Generation job changed campaign scope while opening its stream."), { statusCode: 404 });
    }

    logger.info({
      event: "turn_generation_stream_connected",
      correlationId: request.id,
      generationJobId: jobId
    });
    try {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      if (typeof reply.raw.flushHeaders === "function") reply.raw.flushHeaders();

      let lastSentJson = "";
      const hints = subscription[Symbol.asyncIterator]();
      let pendingHint = hints.next();
      while (!isClosed) {
        const currentJson = JSON.stringify(job);
        if (currentJson !== lastSentJson) {
          lastSentJson = currentJson;
          reply.raw.write(`data: ${currentJson}\n\n`);
          snapshotsSent += 1;
        }
        if (TERMINAL_GENERATION_STATUSES.has(job.status)) {
          finalStatus = job.status;
          break;
        }
        try {
          const wakeup = await generationStreamWakeup(pendingHint);
          if (wakeup.kind === "hint") {
            if (wakeup.result.done) {
              if (!isClosed) finalStatus = "stream_error";
              break;
            }
            pendingHint = hints.next();
          }
          if (isClosed) break;
          job = generationStreamSnapshot(await generationAdapter.getGenerationJob(ownerScope, jobId));
          if (job.campaignId !== firstJob.campaignId) {
            throw new Error("Generation job left its authorized stream scope.");
          }
        } catch (error) {
          if (isClosed) break;
          finalStatus = "stream_error";
          logger.warn({
            correlationId: request.id,
            generationJobId: jobId,
            errorName: error instanceof Error ? error.name : "Error",
            errorCode: safeLogErrorCode(errorCodeFrom(error))
          });
          break;
        }
      }
    } finally {
      await closeSubscription();
      logger.info({
        event: "turn_generation_stream_closed",
        correlationId: request.id,
        generationJobId: jobId,
        finalStatus,
        snapshotsSent,
        durationMs: Date.now() - streamStartedAt
      });
    }
    if (!isClosed) reply.raw.end();
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/result", async (request) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    return parseResponseProjection(generationResultSchema, await generationAdapter.getGenerationResult(ownerScope, jobId));
  });

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/retry", async (request, reply) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    const result = await generationLifecycle.retry(ownerScope.ownerUserId, jobId, () => generationAdapter.retryGeneration(ownerScope, jobId));
    return reply.code(202).send(parseResponseProjection(generationActionResponseSchema, result));
  });

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/cancel", async (request, reply) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    const result = await generationLifecycle.cancel(ownerScope.ownerUserId, jobId, () => generationAdapter.cancelGeneration(ownerScope, jobId));
    return reply.code(202).send(parseResponseProjection(generationActionResponseSchema, result));
  });

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/discard", async (request) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const ownerScope = { ownerUserId: await initialOwnerId(pool) };
    return parseResponseProjection(generationActionResponseSchema, await generationAdapter.discardGeneration(ownerScope, jobId));
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    illustration.getIllustrationConfig({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    })
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover", async (request, reply) => {
    const job = await illustration.enqueueWorldCover({
      ownerUserId: await initialOwnerId(pool),
      worldId: uuidSchema.parse(request.params.worldId)
    }, worldCoverRequestSchema.parse(request.body));
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover-job", async (request) => (
    illustration.getLatestWorldCoverJob({
      ownerUserId: await initialOwnerId(pool),
      worldId: uuidSchema.parse(request.params.worldId)
    })
  ));

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover-asset", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const worldId = uuidSchema.parse(request.params.worldId);
    const body = assetSelectionSchema.parse(request.body);
    const ingress = bindWorldAssetSelectionHttpIngress(
      { ownerUserId },
      { worldId },
      body,
      assetHttpIdempotency(request.headers, "world-cover", { ownerUserId, worldId, body })
    );
    return mapLegacyWorldAssetSelectionHttpResult(
      await apiAssets.assets.selectWorldCover(ingress.scope, ingress.command)
    );
  });

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    illustration.setIllustrationConfig({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    },
      illustrationConfigSchema.parse(request.body)
    )
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/image-jobs", async (request) => ({
    jobs: await illustration.listCampaignImageJobs({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    })
  }));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-segments", async (request) => (
    illustration.listCampaignIllustrationSegments({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    })
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-backfill/preview", async (request) => {
    const body = illustrationBackfillPreviewSchema.parse(request.body);
    return illustration.previewIllustrationBackfill({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    }, body);
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-backfill", async (request, reply) => (
    reply.code(202).send(await illustration.enqueueIllustrationBackfill({
      ownerUserId: await initialOwnerId(pool),
      campaignId: uuidSchema.parse(request.params.campaignId)
    },
      illustrationBackfillRequestSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-segments", async (request, reply) => {
    const result = await illustration.generateTurnIllustrationSegments(
      await illustrationTurnScope(uuidSchema.parse(request.params.turnId)),
      illustrationSegmentRequestSchema.parse(request.body)
    );
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.post<{ Params: { segmentId: string } }>("/api/v1/illustration-segments/:segmentId/images", async (request, reply) => {
    const result = await illustration.regenerateSegmentIllustration(
      await illustrationSegmentScope(uuidSchema.parse(request.params.segmentId)),
      illustrationSegmentImageRequestSchema.parse(request.body)
    );
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.delete<{ Params: { segmentId: string; variantIndex: string } }>(
    "/api/v1/illustration-segments/:segmentId/images/:variantIndex",
    async (request) => illustration.removeSegmentIllustrationVariant(
      await illustrationSegmentScope(uuidSchema.parse(request.params.segmentId)),
      z.coerce.number().int().min(0).max(1).parse(request.params.variantIndex)
    )
  );

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustrations", async (request, reply) => {
    const job = await illustration.enqueueIllustration(
      await illustrationTurnScope(uuidSchema.parse(request.params.turnId)),
      illustrationRequestSchema.parse(request.body)
    );
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.put<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-asset", async (request) => {
    const scope = await illustrationTurnScope(uuidSchema.parse(request.params.turnId));
    const body = assetSelectionSchema.parse(request.body);
    const ingress = bindTurnAssetSelectionHttpIngress(
      scope,
      scope,
      body,
      assetHttpIdempotency(request.headers, "turn-illustration", { ...scope, body })
    );
    return mapLegacyTurnAssetSelectionHttpResult(
      await apiAssets.assets.selectTurnIllustration(ingress.scope, ingress.command)
    );
  });

  app.get<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-resolution", async (request, reply) => {
    const resolution = await illustration.getTurnIllustrationResolution(
      await illustrationTurnScope(uuidSchema.parse(request.params.turnId))
    );
    if (!resolution) return reply.code(404).send({ error: "Not found" });
    return resolution;
  });

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-match", async (request, reply) => (
    reply.code(202).send(await illustration.rematchTurnIllustration(
      await illustrationTurnScope(uuidSchema.parse(request.params.turnId))
    ))
  ));

  app.get<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId", async (request) => (
    illustration.getImageJob({
      ownerUserId: await initialOwnerId(pool),
      jobId: uuidSchema.parse(request.params.jobId)
    })
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(await illustration.retryImageJob({
      ownerUserId: await initialOwnerId(pool),
      jobId: uuidSchema.parse(request.params.jobId)
    }))
  ));

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const scope = { ownerUserId, assetId: uuidSchema.parse(request.params.assetId) };
    const delivery = await apiAssets.assets.describeAssetDelivery(scope, { kind: "original" });
    const session = await apiAssets.storage.adapter.openAssetSession({
      scope,
      request: { kind: "original" },
      limits: assetDeliveryLimits(config.security.apiAssetBodyLimitBytes)
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    return reply
      .type(delivery.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${delivery.etag}\"`)
      .send(createAssetDeliveryStream(session, reply.raw));
  });

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/thumbnail", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const scope = { ownerUserId, assetId: uuidSchema.parse(request.params.assetId) };
    const delivery = await apiAssets.assets.describeAssetDelivery(scope, { kind: "derivative", derivativeKind: "thumbnail" });
    const session = await apiAssets.storage.adapter.openAssetSession({
      scope,
      request: { kind: "derivative", derivativeKind: "thumbnail" },
      limits: assetDeliveryLimits(config.security.apiAssetBodyLimitBytes)
    });
    if (!session) return reply.code(404).send({ error: "Not found" });
    return reply
      .type(delivery.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${delivery.etag}\"`)
      .send(createAssetDeliveryStream(session, reply.raw));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return apiAssets.assets.listAssets({ ownerUserId }, assetListQuerySchema.parse(request.query));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets/facets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await apiAssets.assets.listAssets(
      { ownerUserId },
      assetListQuerySchema.parse({ ...request.query, cursor: undefined, limit: 1 })
    );
    return { total: result.total, facets: result.facets };
  });

  app.patch<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/library-metadata", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const assetId = uuidSchema.parse(request.params.assetId);
    const parsed = assetMetadataUpdateSchema.parse(request.body);
    const body = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined)
    ) as unknown as Parameters<typeof bindAssetMetadataHttpIngress>[2];
    const ingress = bindAssetMetadataHttpIngress(
      { ownerUserId },
      assetId,
      body,
      assetHttpIdempotency(request.headers, "asset-library-metadata", { ownerUserId, assetId, body })
    );
    return apiAssets.assets.updateAssetMetadata(ingress.scope, ingress.command);
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/metrics", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return memoryAdapter.metrics(ownerUserId, uuidSchema.parse(request.params.campaignId));
  });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    "/api/v1/campaigns/:campaignId/memory/context-preview",
    async (request) => {
      const query = memoryContextQuerySchema.parse(request.query);
      const ownerUserId = await initialOwnerId(pool);
      return memoryAdapter.contextPreview(ownerUserId, uuidSchema.parse(request.params.campaignId), query);
    }
  );

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/reindex", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    return reply.code(202).send(await memoryAdapter.reindex(ownerUserId, uuidSchema.parse(request.params.campaignId)));
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => (
    memoryAdapter.embeddingConfig(await initialOwnerId(pool), uuidSchema.parse(request.params.campaignId))
  ));

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const ownerUserId = await initialOwnerId(pool);
    const saved = await memoryAdapter.setEmbeddingConfig(ownerUserId, campaignId, campaignEmbeddingConfigSchema.parse(request.body));
    const jobId = saved.enabled === true ? await memoryAdapter.reindexEmbeddings(ownerUserId, campaignId) : null;
    return { ...saved, jobId };
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embeddings/reindex", async (request, reply) => {
    const jobId = await memoryAdapter.reindexEmbeddings(await initialOwnerId(pool), uuidSchema.parse(request.params.campaignId));
    if (!jobId) return reply.code(409).send({ error: "Not configured", message: "Enable semantic memory and select an embedding provider first." });
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/jobs/:jobId", async (request, reply) => {
    try {
      return await memoryAdapter.job(await initialOwnerId(pool), uuidSchema.parse(request.params.jobId));
    } catch (error) {
      if (statusCode(error) === 404) return reply.code(404).send({ error: "Not found", message: "Job not found." });
      throw error;
    }
  });

  return app;
}

function requestLogError(reply: { log: { error: (value: unknown, message?: string) => void } }, error: unknown): void {
  reply.log.error({ err: error }, "readiness_check_failed");
}
