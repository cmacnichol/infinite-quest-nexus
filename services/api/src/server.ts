import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import { z } from "zod";
import type { RuntimeConfig } from "../../../packages/database/src/config.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";
import { initialOwnerId } from "../../../packages/database/src/pool.js";
import { createLoggerOptions, logger } from "../../../packages/logger/src/index.js";
import { characterLegacyText, effectiveCampaignCharacter } from "../../../packages/domain/src/world-characters.js";
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
import { sha256, stableStringify } from "../../../packages/domain/src/text.js";
import { readTurnPage } from "../../../packages/database/src/play-loop-read-repository.js";
import { userProfileUpdateSchema } from "../../../packages/contracts/src/users.js";
import { assetListQuerySchema, assetMetadataUpdateSchema } from "../../../packages/contracts/src/assets.js";
import {
  campaignTransferCommitRequestSchema,
  campaignTransferPreviewRequestSchema
} from "../../../packages/contracts/src/campaign-transfer.js";
import { previewLegacyStoryImport } from "./import-service.js";
import { getImportProgress, importInfiniteWorlds, previewInfiniteWorldsImport } from "./infinite-worlds-import-service.js";
import { getSessionUserProfile, updateSessionUserProfile } from "./user-service.js";
import { listPromptLibrary, previewPromptTemplate, resetPromptOverride, savePromptOverride } from "./prompt-library-service.js";
import {
  buildContextPreview,
  enqueueChronicleReindex,
  enqueueEmbeddingReindex,
  getCampaignEmbeddingConfig,
  getChronicleMetrics,
  setCampaignEmbeddingConfig
} from "./memory-service.js";
import { queryAssets, readAsset, readAssetDerivative, selectTurnIllustration, selectWorldCover, updateAssetMetadata, type FilesystemAssetStore } from "./asset-service.js";
import { createProvider, deleteProvider, discoverUnsavedProviderModels, generateProviderText, listProviders, providerModels, setDefaultProvider, updateProvider } from "./provider-service.js";
import { branchCampaign, cancelGeneration, discardGeneration, enqueueGeneration, enqueueLatestReplacement, getGenerationJob, getGenerationResult, retryGeneration, rewindCampaign, syncPlayerCampaignConfig } from "./generation-service.js";
import { getCampaignRuntimeState, updateCampaignRuntimeState } from "./campaign-state-service.js";
import {
  enqueueIllustration,
  enqueueWorldCover,
  getIllustrationConfig,
  getImageJob,
  getLatestWorldCoverJob,
  listCampaignImageJobs,
  retryImageJob,
  setIllustrationConfig
} from "./image-service.js";
import {
  createCampaign,
  createWorld,
  deleteCampaign,
  deleteWorld,
  deleteWorldVersion,
  exportWorld,
  forkWorld,
  getWorldVersionPlayableCharacterSummary,
  getWorld,
  importWorld,
  listCampaigns,
  listWorlds,
  migrateCampaignWorld,
  previewWorldImport,
  publishWorld,
  updateCampaign,
  updateWorld,
  updateWorldDraft
} from "./world-service.js";
import { generatePlayableCharacter, generatePlayableCharacterPreview, generateWorldPreview } from "./world-generator-service.js";
import { deleteExpiredWorldGenerationProgress, getWorldGenerationProgress } from "./world-generation-progress-service.js";
import {
  getCampaignCharacterProfile,
  organizeCampaignCharacterProfile,
  organizeWorldCharacterProfile,
  updateCampaignCharacterProfile
} from "./character-profile-service.js";
import { getCampaignCostSummary, turnReportedCosts } from "./cost-service.js";
import { classifyTurnInput } from "./turn-intent-service.js";
import { previewCampaignWorldTransfer, transferCampaignWorld } from "./campaign-transfer-service.js";
import { applicationMetadata } from "./app-metadata.js";
import { getDashboardStats } from "./dashboard-service.js";
import { getTurnIllustrationResolution, rematchTurnIllustration } from "./illustration-resolution-service.js";
import { installRequestSecurity } from "./request-security.js";
import { registerArchiveRoutes } from "./archive-routes.js";
import {
  enqueueIllustrationBackfill,
  generateTurnIllustrationSegments,
  listCampaignIllustrationSegments,
  previewIllustrationBackfill,
  regenerateSegmentIllustration,
  removeSegmentIllustrationVariant
} from "./segmented-illustration-service.js";

type BuildServerOptions = {
  config: RuntimeConfig;
  pool: DatabasePool;
};

const uuidSchema = z.uuid();
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

function generationSnapshot(value: unknown) {
  return parseResponseProjection(generationJobSnapshotSchema, value);
}

function generationStreamSnapshot(value: unknown) {
  return parseResponseProjection(generationStreamSnapshotSchema, value);
}

export async function buildServer({ config, pool }: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createLoggerOptions(),
    bodyLimit: config.security.apiDefaultBodyLimitBytes,
    trustProxy: config.security.trustProxyHops,
    requestIdHeader: "x-correlation-id",
    genReqId: () => crypto.randomUUID()
  });

  app.setErrorHandler((error, request, reply) => {
    const code = statusCode(error);
    const details = errorDetails(error);
    const exposed = exposeError(error, code);
    const transport = providerTransportErrorDetails(error);
    const exposedError = (details.name === "ArchiveError" || details.name === "OriginNotAllowedError") && details.code
      ? details.code
      : details.name;
    request.log.error({ err: error, code }, "request_failed");
    const payload = apiErrorEnvelopeSchema.parse({
      error: exposed ? (exposedError || "Provider request failed") : "Internal server error",
      message: exposed ? `${details.message} Correlation ID: ${request.id}.` : "The request failed. Use the correlation ID to locate server diagnostics.",
      correlationId: request.id,
      ...(!exposed || details.code === undefined ? {} : { code: details.code }),
      details: transport
        ? { code: transport.timedOut ? "provider_request_timeout" : "provider_transport_error", transport }
        : exposed ? safeErrorDetails(details.details) : {},
      ...(details.issues === undefined ? {} : { issues: details.issues })
    });
    void reply.code(code).send(payload);
  });

  installRequestSecurity(app, config);

  app.options("*", async (_request, reply) => {
    return reply.code(204).send();
  });

  await mkdir(config.assetStorageRoot, { recursive: true });
  await mkdir(config.archiveStorageRoot, { recursive: true });
  const assetStore: FilesystemAssetStore = { root: config.assetStorageRoot };
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.security.apiImportBodyLimitBytes,
      fieldSize: config.security.apiImportBodyLimitBytes
    }
  });
  await app.register(registerArchiveRoutes, { pool, config, assetStore });
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

  app.get("/api/v1/meta", async () => parseResponseProjection(metaResponseSchema, { application: applicationMetadata() }));

  app.get("/api/v1/dashboard/stats", async () => getDashboardStats(pool));

  app.get("/api/v1/session", async () => {
    const user = await getSessionUserProfile(pool);
    return parseResponseProjection(sessionResponseSchema, { user, authentication: "deferred" });
  });

  app.get("/api/v1/users/me", async () => ({ user: await getSessionUserProfile(pool) }));
  app.get("/api/v1/user/profile", async () => ({ user: await getSessionUserProfile(pool) }));

  app.patch("/api/v1/users/me/profile", async (request) => parseResponseProjection(userProfileResponseSchema, {
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.put("/api/v1/users/me/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.patch("/api/v1/user/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));
  app.put("/api/v1/user/profile", async (request) => ({
    user: await updateSessionUserProfile(pool, userProfileUpdateSchema.parse(request.body))
  }));

  app.get("/api/v1/prompt-library", async (request) => {
    const query = z.object({ campaignId: z.uuid().optional() }).parse(request.query);
    return listPromptLibrary(pool, query.campaignId);
  });
  app.put("/api/v1/prompt-library/overrides", async (request) => ({ library: await savePromptOverride(pool, request.body) }));
  app.delete("/api/v1/prompt-library/overrides", async (request) => ({ library: await resetPromptOverride(pool, request.body) }));
  app.post("/api/v1/prompt-library/preview", async (request) => previewPromptTemplate(request.body));

  app.get("/api/v1/providers", async () => parseResponseProjection(providerListResponseSchema, { providers: await listProviders(pool) }));

  app.post("/api/v1/providers", async (request, reply) => {
    const input = providerProfileInputSchema.parse(request.body);
    const provider = await createProvider(pool, input, config.credentialEncryptionKey);
    return reply.code(201).send(provider);
  });

  app.get<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/models", async (request) => ({
    models: await providerModels(pool, uuidSchema.parse(request.params.providerId), config.credentialEncryptionKey)
  }));

  app.put<{ Params: { providerId: string } }>("/api/v1/providers/:providerId/default", async (request) => (
    setDefaultProvider(pool, uuidSchema.parse(request.params.providerId))
  ));

  app.patch<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    updateProvider(pool, uuidSchema.parse(request.params.providerId), providerProfileUpdateSchema.parse(request.body), config.credentialEncryptionKey)
  ));

  app.post("/api/v1/provider-text/generate", async (request) => (
    generateProviderText(pool, providerTextRequestSchema.parse(request.body), config.credentialEncryptionKey)
  ));

  app.post("/api/v1/providers/discover-models", async (request) => ({
    models: await discoverUnsavedProviderModels(providerProfileInputSchema.parse(request.body))
  }));

  app.delete<{ Params: { providerId: string } }>("/api/v1/providers/:providerId", async (request) => (
    deleteProvider(pool, uuidSchema.parse(request.params.providerId))
  ));

  app.post("/api/v1/imports/legacy-story/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => (
    previewLegacyStoryImport(pool, storyImportPreviewRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/world/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => (
    previewWorldImport(pool, worldImportRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/world", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    const result = await importWorld(pool, worldImportRequestSchema.parse(request.body));
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.post("/api/v1/imports/infinite-worlds/preview", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request) => (
    previewInfiniteWorldsImport(pool, infiniteWorldsImportRequestSchema.parse(request.body))
  ));

  app.post("/api/v1/imports/infinite-worlds", { bodyLimit: config.security.apiImportBodyLimitBytes }, async (request, reply) => {
    const result = await importInfiniteWorlds(
      pool,
      infiniteWorldsImportRequestSchema.parse(request.body),
      config.credentialEncryptionKey,
      assetStore
    );
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get<{ Querystring: { key?: string } }>("/api/v1/imports/progress", async (request, reply) => {
    const key = String(request.query.key || "").trim();
    const progress = getImportProgress(key);
    if (!progress) return reply.code(404).send({ error: "No active import found for the provided key." });
    return progress;
  });

  app.get("/api/v1/worlds", async () => parseResponseProjection(worldListResponseSchema, { worlds: await listWorlds(pool) }));

  app.post("/api/v1/worlds", async (request, reply) => (
    reply.code(201).send(parseResponseProjection(worldCreateResponseSchema, await createWorld(pool, worldCreateSchema.parse(request.body))))
  ));

  app.post("/api/v1/worlds/generate-preview", async (request) => (
    generateWorldPreview(
      pool,
      worldGenerationPreviewRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.get<{ Querystring: { key?: string } }>("/api/v1/worlds/generate-progress", async (request) => {
    const key = String(request.query.key || "").trim();
    if (!key) return { status: "unknown", phase: "unknown", progressPercent: 0, message: "" };
    const ownerUserId = await initialOwnerId(pool);
    if (Date.now() - lastWorldGenerationProgressCleanupAt >= 60_000) {
      lastWorldGenerationProgressCleanupAt = Date.now();
      await deleteExpiredWorldGenerationProgress(pool);
    }
    const progress = await getWorldGenerationProgress(pool, ownerUserId, key);
    return progress || { status: "unknown", phase: "unknown", progressPercent: 0, message: "" };
  });

  app.post("/api/v1/worlds/playable-characters/generate-preview", async (request) => (
    generatePlayableCharacterPreview(
      pool,
      playableCharacterGenerationPreviewRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    getWorld(pool, uuidSchema.parse(request.params.worldId))
  ));

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft", async (request) => (
    updateWorldDraft(pool, uuidSchema.parse(request.params.worldId), worldDraftUpdateSchema.parse(request.body))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft/playable-characters/generate", async (request) => (
    generatePlayableCharacter(
      pool,
      uuidSchema.parse(request.params.worldId),
      playableCharacterGenerationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/draft/playable-characters/organize", async (request) => (
    organizeWorldCharacterProfile(
      pool,
      uuidSchema.parse(request.params.worldId),
      characterProfileOrganizationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/publish", async (request, reply) => (
    reply.code(201).send(await publishWorld(pool, uuidSchema.parse(request.params.worldId), worldPublishSchema.parse(request.body)))
  ));

  app.patch<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    updateWorld(pool, uuidSchema.parse(request.params.worldId), worldStatusUpdateSchema.parse(request.body))
  ));

  app.delete<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId", async (request) => (
    deleteWorld(pool, uuidSchema.parse(request.params.worldId), resourceDeleteSchema.parse(request.body))
  ));

  app.delete<{ Params: { worldId: string; worldVersionId: string } }>("/api/v1/worlds/:worldId/versions/:worldVersionId", async (request) => (
    deleteWorldVersion(
      pool,
      uuidSchema.parse(request.params.worldId),
      uuidSchema.parse(request.params.worldVersionId),
      worldVersionDeleteSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/fork", async (request, reply) => (
    reply.code(201).send(await forkWorld(pool, uuidSchema.parse(request.params.worldId), worldForkSchema.parse(request.body)))
  ));

  app.get<{ Params: { worldId: string }; Querystring: { worldVersionId?: string } }>("/api/v1/worlds/:worldId/export", async (request, reply) => {
    const versionId = request.query.worldVersionId ? uuidSchema.parse(request.query.worldVersionId) : undefined;
    return reply
      .header("content-disposition", 'attachment; filename="infinite-quest-world.json"')
      .send(await exportWorld(pool, uuidSchema.parse(request.params.worldId), versionId));
  });

  app.get("/api/v1/campaigns", async () => {
    return parseResponseProjection(campaignListResponseSchema, { campaigns: await listCampaigns(pool) });
  });

  app.get<{ Params: { worldVersionId: string } }>("/api/v1/world-versions/:worldVersionId/playable-characters", async (request) => (
    parseResponseProjection(playableCharacterListResponseSchema, await getWorldVersionPlayableCharacterSummary(pool, uuidSchema.parse(request.params.worldVersionId)))
  ));

  app.post("/api/v1/campaigns", async (request, reply) => (
    reply.code(201).send(parseResponseProjection(campaignCreateResponseSchema, await createCampaign(pool, campaignCreateSchema.parse(request.body))))
  ));

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    updateCampaign(pool, uuidSchema.parse(request.params.campaignId), campaignUpdateSchema.parse(request.body))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile", async (request) => (
    getCampaignCharacterProfile(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile", async (request) => (
    updateCampaignCharacterProfile(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignCharacterProfileUpdateSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/character-profile/organize", async (request) => (
    organizeCampaignCharacterProfile(
      pool,
      uuidSchema.parse(request.params.campaignId),
      characterProfileOrganizationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    )
  ));

  app.delete<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId", async (request) => (
    deleteCampaign(pool, uuidSchema.parse(request.params.campaignId), resourceDeleteSchema.parse(request.body))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/migrate-world", async (request) => (
    migrateCampaignWorld(pool, uuidSchema.parse(request.params.campaignId), campaignWorldMigrationSchema.parse(request.body))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world/preview", async (request) => (
    previewCampaignWorldTransfer(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignTransferPreviewRequestSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/transfer-world", async (request, reply) => {
    const result = await transferCampaignWorld(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignTransferCommitRequestSchema.parse(request.body)
    );
    return reply.code(result.reused ? 200 : 201).send(result);
  });

  app.get<{ Params: { campaignId: string }; Querystring: { before?: string; limit?: string } }>("/api/v1/campaigns/:campaignId/turns", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const pageRequest = turnPageRequestSchema.parse(request.query);
    const page = await readTurnPage(pool, ownerUserId, campaignId, pageRequest.before, pageRequest.limit ?? 50);
    const costs = await turnReportedCosts(pool, ownerUserId, page.turns.map((turn) => turn.id));
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

  app.get<{ Params: { campaignId: string }; Querystring: { turnNumber?: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    parseResponseProjection(campaignRuntimeStateResponseSchema, await getCampaignRuntimeState(
      pool,
      uuidSchema.parse(request.params.campaignId),
      request.query.turnNumber === undefined ? undefined : z.coerce.number().int().min(0).parse(request.query.turnNumber)
    ))
  ));

  app.patch<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/state", async (request) => (
    parseResponseProjection(campaignRuntimeStateResponseSchema, await updateCampaignRuntimeState(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignRuntimeStateUpdateSchema.parse(request.body)
    ))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/cost-summary", async (request) => (
    getCampaignCostSummary(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.get<{ Params: { campaignId: string }; Querystring: { since?: string } }>("/api/v1/campaigns/:campaignId/sync-status", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const syncRequest = syncStatusRequestSchema.parse(request.query);
    const result = await pool.query(
      `SELECT c.id, c.title, c.active_turn_number AS "activeTurnNumber", c.world_version_id AS "worldVersionId",
              c.story_length_profile AS "storyLengthProfile", c.updated_at AS "updatedAt",
              c.turn_control_style AS "turnControlStyle",
              c.selected_character_id AS "selectedCharacterId", c.character_snapshot AS "characterSnapshot",
              c.character_profile AS "characterProfile", c.character_profile_revision AS "characterProfileRevision",
              c.legacy_settings AS "legacySettings", c.status,
              w.id AS "worldId", w.title AS "worldTitle", wv.version_number AS "worldVersionNumber",
              wv.content AS "worldContent",
              cs.rpg_stats AS "rpgStats", cs.event_triggers AS "eventTriggers", cs.trackers AS "trackers",
              pending.id AS "pendingGenerationId", pending.status AS "pendingGenerationStatus",
              pending.action AS "pendingGenerationAction", pending.operation_kind AS "pendingGenerationOperationKind",
              pending.requested_input_mode AS "pendingRequestedInputMode",
              pending.resolved_input_mode AS "pendingResolvedInputMode", pending.input_mode_source AS "pendingInputModeSource",
              pending.expected_turn_number AS "pendingGenerationExpectedTurnNumber",
              pending.created_at AS "pendingGenerationCreatedAt", pending.updated_at AS "pendingGenerationUpdatedAt",
              recovery.id AS "recoveryId", recovery.status AS "recoveryStatus", recovery.operation_kind AS "recoveryOperationKind",
              recovery.expected_turn_number AS "recoveryExpectedTurnNumber", recovery.attempts AS "recoveryAttempts",
              recovery.error_code AS "recoveryErrorCode", recovery.error_message AS "recoveryErrorMessage", recovery.result_turn_id AS "recoveryResultTurnId",
              recovery.replacement_turn_id AS "recoveryReplacementTurnId"
         FROM campaigns c
         JOIN world_versions wv ON wv.id = c.world_version_id AND wv.owner_user_id = c.owner_user_id
         JOIN worlds w ON w.id = wv.world_id AND w.owner_user_id = c.owner_user_id
         LEFT JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         LEFT JOIN LATERAL (
           SELECT id, status, action, operation_kind, requested_input_mode, resolved_input_mode, input_mode_source,
                  expected_turn_number, created_at, updated_at
             FROM generation_jobs
            WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              AND status IN ('queued','replacement_queued','assessing','generating','validating','committing')
            ORDER BY created_at DESC LIMIT 1
         ) pending ON true
         LEFT JOIN LATERAL (
           SELECT id, status, operation_kind, expected_turn_number, attempts, error_code, error_message, result_turn_id, replacement_turn_id
             FROM generation_jobs
            WHERE campaign_id = c.id AND owner_user_id = c.owner_user_id
              AND status IN ('recoverable','failed','completed')
            ORDER BY updated_at DESC, id DESC LIMIT 1
         ) recovery ON true
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [uuidSchema.parse(request.params.campaignId), ownerUserId]
    );
    const row = result.rows[0];
    if (!row) {
      throw Object.assign(new Error("Campaign not found."), {
        name: "CampaignNotFoundError",
        statusCode: 404,
        details: { code: "campaign_not_found" }
      });
    }
    const content = typeof row.worldContent === "string" ? JSON.parse(row.worldContent) : (row.worldContent || {});
    const worldOverview = content.world || {};
    const effectiveCharacter = effectiveCampaignCharacter(row.characterProfile, row.characterSnapshot);
    const campaign = {
      id: row.id,
      title: row.title,
      activeTurnNumber: row.activeTurnNumber,
      worldVersionId: row.worldVersionId,
      storyLengthProfile: row.storyLengthProfile,
      updatedAt: row.updatedAt,
      selectedCharacterId: row.selectedCharacterId,
      selectedCharacterName: effectiveCharacter.name,
      characterSnapshot: row.characterSnapshot,
      characterProfile: row.characterProfile,
      characterProfileRevision: row.characterProfileRevision,
      status: row.status
    };
    const world = {
      id: row.worldId,
      title: row.worldTitle || worldOverview.title || "",
      versionNumber: row.worldVersionNumber,
      genre: worldOverview.genre || "",
      tone: worldOverview.tone || "",
      premise: worldOverview.premise || "",
      backgroundStory: worldOverview.backgroundStory || "",
      character: characterLegacyText(row.characterProfile, row.characterSnapshot) || "",
      firstAction: worldOverview.firstAction || "",
      rules: worldOverview.rules || "",
      playableCharacters: content.playableCharacters || []
    };
    const playerConfig = {
      selectedCharacterId: row.selectedCharacterId,
      selectedCharacterName: effectiveCharacter.name,
      characterSnapshot: row.characterSnapshot,
      characterProfile: row.characterProfile,
      characterProfileRevision: row.characterProfileRevision,
      rpgStats: row.rpgStats || [],
      trackers: row.trackers || [],
      eventTriggers: row.eventTriggers || [],
      useRpgStats: Boolean(row.legacySettings?.useRpgStats),
      suppressEventTriggers: Boolean(row.legacySettings?.suppressEventTriggers)
    };
    const pendingGeneration = row.pendingGenerationId ? {
      id: row.pendingGenerationId,
      status: row.pendingGenerationStatus,
      action: row.pendingGenerationAction,
      operationKind: row.pendingGenerationOperationKind,
      expectedTurnNumber: row.pendingGenerationExpectedTurnNumber,
      createdAt: row.pendingGenerationCreatedAt,
      updatedAt: row.pendingGenerationUpdatedAt
    } : null;
    const turnPage = await readTurnPage(pool, ownerUserId, campaign.id, undefined, 50);
    const costs = await turnReportedCosts(pool, ownerUserId, turnPage.turns.map((turn) => turn.id));
    const turns = {
      campaignId: campaign.id,
      turns: turnPage.turns.map((turn) => ({ ...turn, narration: formatNarrationParagraphs(turn.narration), reportedCost: costs.get(turn.id) || null })),
      nextCursor: turnPage.nextCursor
    };
    const generationRecovery = row.recoveryId && !turns.turns.some((turn) => turn.id === row.recoveryResultTurnId) ? {
      id: row.recoveryId,
      status: row.recoveryStatus,
      operationKind: row.recoveryOperationKind,
      expectedTurnNumber: row.recoveryExpectedTurnNumber,
      attempts: row.recoveryAttempts,
      errorCode: row.recoveryErrorCode,
      errorMessage: row.recoveryErrorMessage,
      resultTurnId: row.recoveryResultTurnId,
      replacementTurnId: row.recoveryReplacementTurnId
    } : null;
    const syncToken = sha256(stableStringify({
      ownerUserId, campaign, world, playerConfig,
      latestTurnId: turns.turns.at(-1)?.id ?? null, latestTurnNumber: turns.turns.at(-1)?.turnNumber ?? null,
      pendingGenerationId: pendingGeneration?.id ?? null, pendingGenerationStatus: pendingGeneration?.status ?? null,
      pendingGenerationUpdatedAt: pendingGeneration?.updatedAt ?? null,
      recoveryId: generationRecovery?.id ?? null, recoveryStatus: generationRecovery?.status ?? null,
      recoveryAttempts: generationRecovery?.attempts ?? null,
      recoveryReplacementTurnId: generationRecovery?.replacementTurnId ?? null
    }));
    const unchanged = syncRequest.since === syncToken;
    return parseResponseProjection(campaignSyncStatusSchema, {
      ...campaign, campaign, world, playerConfig, pendingGeneration, syncToken,
      turnWindowMode: unchanged ? "unchanged" : "replace",
      turns: unchanged ? null : turns,
      generationRecovery
    });
  });

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/player-config", async (request) => (
    syncPlayerCampaignConfig(
      pool,
      uuidSchema.parse(request.params.campaignId),
      playerCampaignConfigSchema.parse(request.body)
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/rewind", async (request) => (
    parseResponseProjection(campaignRewindResponseSchema, await rewindCampaign(
      pool,
      uuidSchema.parse(request.params.campaignId),
      campaignRewindSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/branch", async (request, reply) => (
    reply.code(201).send(
      parseResponseProjection(campaignBranchResponseSchema, await branchCampaign(
        pool,
        uuidSchema.parse(request.params.campaignId),
        campaignBranchSchema.parse(request.body)
      ))
    )
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/turn-input/classify", async (request) => (
    parseResponseProjection(turnInputClassificationResponseSchema, await classifyTurnInput(
      pool,
      uuidSchema.parse(request.params.campaignId),
      turnInputClassificationRequestSchema.parse(request.body),
      config.credentialEncryptionKey
    ))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations", async (request, reply) => {
    const body = generationRequestSchema.parse(request.body);
    const job = await enqueueGeneration(pool, uuidSchema.parse(request.params.campaignId), body);
    return reply.code(job.duplicate ? 200 : 202).send(parseResponseProjection(generationEnqueueResponseSchema, job));
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/generations/retry-latest", async (request, reply) => {
    const body = generationRetryLatestRequestSchema.parse(request.body);
    const job = await enqueueLatestReplacement(pool, uuidSchema.parse(request.params.campaignId), body);
    return reply.code(job.duplicate ? 200 : 202).send(parseResponseProjection(generationEnqueueResponseSchema, job));
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId", async (request) => (
    generationSnapshot(await getGenerationJob(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/stream", async (request, reply) => {
    const jobId = uuidSchema.parse(request.params.jobId);
    const streamStartedAt = Date.now();
    let snapshotsSent = 0;
    let finalStatus = "client_closed";
    let isClosed = false;
    request.raw.on("close", () => { isClosed = true; });
    let job = generationStreamSnapshot(await getGenerationJob(pool, jobId));

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
      while (!isClosed) {
        const currentJson = JSON.stringify(job);
        if (currentJson !== lastSentJson) {
          lastSentJson = currentJson;
          reply.raw.write(`data: ${currentJson}\n\n`);
          snapshotsSent += 1;
        }
        if (["completed", "failed", "recoverable", "discarded", "cancelled"].includes(job.status)) {
          finalStatus = job.status;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        if (isClosed) break;
        try {
          job = generationStreamSnapshot(await getGenerationJob(pool, jobId));
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

  app.get<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/result", async (request) => (
    parseResponseProjection(generationResultSchema, await getGenerationResult(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(parseResponseProjection(generationActionResponseSchema, await retryGeneration(pool, uuidSchema.parse(request.params.jobId))))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/cancel", async (request, reply) => (
    reply.code(202).send(parseResponseProjection(generationActionResponseSchema, await cancelGeneration(pool, uuidSchema.parse(request.params.jobId))))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/generation-jobs/:jobId/discard", async (request) => (
    parseResponseProjection(generationActionResponseSchema, await discardGeneration(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    getIllustrationConfig(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.post<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover", async (request, reply) => {
    const job = await enqueueWorldCover(pool, uuidSchema.parse(request.params.worldId), worldCoverRequestSchema.parse(request.body));
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.get<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover-job", async (request) => (
    getLatestWorldCoverJob(pool, uuidSchema.parse(request.params.worldId))
  ));

  app.put<{ Params: { worldId: string } }>("/api/v1/worlds/:worldId/cover-asset", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const body = assetSelectionSchema.parse(request.body);
    return selectWorldCover(pool, ownerUserId, uuidSchema.parse(request.params.worldId), body.assetId);
  });

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-config", async (request) => (
    setIllustrationConfig(
      pool,
      uuidSchema.parse(request.params.campaignId),
      illustrationConfigSchema.parse(request.body)
    )
  ));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/image-jobs", async (request) => ({
    jobs: await listCampaignImageJobs(pool, uuidSchema.parse(request.params.campaignId))
  }));

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-segments", async (request) => (
    listCampaignIllustrationSegments(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-backfill/preview", async (request) => {
    const body = illustrationBackfillPreviewSchema.parse(request.body);
    return previewIllustrationBackfill(pool, uuidSchema.parse(request.params.campaignId), body.mode);
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/illustration-backfill", async (request, reply) => (
    reply.code(202).send(await enqueueIllustrationBackfill(
      pool,
      uuidSchema.parse(request.params.campaignId),
      illustrationBackfillRequestSchema.parse(request.body)
    ))
  ));

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-segments", async (request, reply) => {
    const result = await generateTurnIllustrationSegments(
      pool,
      uuidSchema.parse(request.params.turnId),
      illustrationSegmentRequestSchema.parse(request.body)
    );
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.post<{ Params: { segmentId: string } }>("/api/v1/illustration-segments/:segmentId/images", async (request, reply) => {
    const result = await regenerateSegmentIllustration(
      pool,
      uuidSchema.parse(request.params.segmentId),
      illustrationSegmentImageRequestSchema.parse(request.body)
    );
    return reply.code(result.duplicate ? 200 : 202).send(result);
  });

  app.delete<{ Params: { segmentId: string; variantIndex: string } }>(
    "/api/v1/illustration-segments/:segmentId/images/:variantIndex",
    async (request) => removeSegmentIllustrationVariant(
      pool,
      uuidSchema.parse(request.params.segmentId),
      z.coerce.number().int().min(0).max(1).parse(request.params.variantIndex)
    )
  );

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustrations", async (request, reply) => {
    const job = await enqueueIllustration(pool, uuidSchema.parse(request.params.turnId), illustrationRequestSchema.parse(request.body));
    return reply.code(job.duplicate ? 200 : 202).send(job);
  });

  app.put<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-asset", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const body = assetSelectionSchema.parse(request.body);
    return selectTurnIllustration(pool, ownerUserId, uuidSchema.parse(request.params.turnId), body.assetId);
  });

  app.get<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-resolution", async (request, reply) => {
    const resolution = await getTurnIllustrationResolution(pool, uuidSchema.parse(request.params.turnId));
    if (!resolution) return reply.code(404).send({ error: "Not found" });
    return resolution;
  });

  app.post<{ Params: { turnId: string } }>("/api/v1/turns/:turnId/illustration-match", async (request, reply) => (
    reply.code(202).send(await rematchTurnIllustration(pool, uuidSchema.parse(request.params.turnId)))
  ));

  app.get<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId", async (request) => (
    getImageJob(pool, uuidSchema.parse(request.params.jobId))
  ));

  app.post<{ Params: { jobId: string } }>("/api/v1/image-jobs/:jobId/retry", async (request, reply) => (
    reply.code(202).send(await retryImageJob(pool, uuidSchema.parse(request.params.jobId)))
  ));

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const asset = await readAsset(pool, assetStore, ownerUserId, uuidSchema.parse(request.params.assetId));
    return reply
      .type(asset.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${asset.contentHash}\"`)
      .send(asset.bytes);
  });

  app.get<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/thumbnail", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const asset = await readAssetDerivative(pool, assetStore, ownerUserId, uuidSchema.parse(request.params.assetId), "thumbnail");
    return reply
      .type(asset.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("etag", `\"${asset.contentHash}\"`)
      .send(asset.bytes);
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return queryAssets(pool, ownerUserId, assetListQuerySchema.parse(request.query));
  });

  app.get<{ Querystring: Record<string, unknown> }>("/api/v1/assets/facets", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await queryAssets(pool, ownerUserId, assetListQuerySchema.parse({ ...request.query, cursor: undefined, limit: 1 }));
    return { total: result.total, facets: result.facets };
  });

  app.patch<{ Params: { assetId: string } }>("/api/v1/assets/:assetId/library-metadata", async (request) => {
    const ownerUserId = await initialOwnerId(pool);
    return updateAssetMetadata(
      pool,
      ownerUserId,
      uuidSchema.parse(request.params.assetId),
      assetMetadataUpdateSchema.parse(request.body)
    );
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/metrics", async (request) => {
    return getChronicleMetrics(pool, uuidSchema.parse(request.params.campaignId));
  });

  app.get<{ Params: { campaignId: string }; Querystring: Record<string, unknown> }>(
    "/api/v1/campaigns/:campaignId/memory/context-preview",
    async (request) => {
      const query = memoryContextQuerySchema.parse(request.query);
      return buildContextPreview(pool, uuidSchema.parse(request.params.campaignId), query, config.credentialEncryptionKey);
    }
  );

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/reindex", async (request, reply) => {
    const jobId = await enqueueChronicleReindex(pool, uuidSchema.parse(request.params.campaignId));
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => (
    getCampaignEmbeddingConfig(pool, uuidSchema.parse(request.params.campaignId))
  ));

  app.put<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embedding-config", async (request) => {
    const campaignId = uuidSchema.parse(request.params.campaignId);
    const saved = await setCampaignEmbeddingConfig(pool, campaignId, campaignEmbeddingConfigSchema.parse(request.body));
    const jobId = saved.enabled ? await enqueueEmbeddingReindex(pool, campaignId) : null;
    return { ...saved, jobId };
  });

  app.post<{ Params: { campaignId: string } }>("/api/v1/campaigns/:campaignId/memory/embeddings/reindex", async (request, reply) => {
    const jobId = await enqueueEmbeddingReindex(pool, uuidSchema.parse(request.params.campaignId));
    if (!jobId) return reply.code(409).send({ error: "Not configured", message: "Enable semantic memory and select an embedding provider first." });
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { jobId: string } }>("/api/v1/jobs/:jobId", async (request, reply) => {
    const ownerUserId = await initialOwnerId(pool);
    const result = await pool.query(
      `SELECT id, campaign_id AS "campaignId", job_type AS "jobType", status, attempts,
              progress, error_message AS "errorMessage", created_at AS "createdAt", updated_at AS "updatedAt",
              completed_at AS "completedAt"
         FROM chronicle_jobs WHERE id = $1 AND owner_user_id = $2`,
      [uuidSchema.parse(request.params.jobId), ownerUserId]
    );
    const job = result.rows[0];
    return job ? job : reply.code(404).send({ error: "Not found", message: "Job not found." });
  });

  return app;
}

function requestLogError(reply: { log: { error: (value: unknown, message?: string) => void } }, error: unknown): void {
  reply.log.error({ err: error }, "readiness_check_failed");
}
