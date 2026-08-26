import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ArchiveAssetBinding } from "../../packages/contracts/src/archives.js";
import { characterProfileSchema, worldContentSchema } from "../../packages/contracts/src/world-library.js";
import {
  SYSTEM_ARCHIVE_DOMAINS,
  systemArchiveAssetsPayloadSchema,
  systemArchiveJobViewSchema,
  systemArchiveManifestSchema,
  systemArchivePayloadSchema,
  systemImportPreviewViewSchema,
  systemRecordEnvelopeSchema,
  type SystemArchiveDomain,
  type SystemArchiveJobView,
  type SystemImportPreviewView,
  type SystemRecordEnvelope,
} from "../../packages/contracts/src/system-archives.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import {
  createDatabasePool,
  initialOwnerId,
  type DatabasePool,
} from "../../packages/database/src/pool.js";
import {
  stageArchiveUpload,
  supportsSecureGeneratedArchiveStaging,
} from "../../services/api/src/archive-io.js";
import { inspectSystemArchiveForPreview } from "../../services/runtime/src/system-archive-composition.js";

const fixtureRoot = resolve("tests/fixtures/system-archives/v1-minimal");
const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const deterministicHistorySourceId = (eventType: string, campaignId: string): string => {
  const digest = [...createHash("md5").update(`${eventType}:${campaignId}`).digest("hex")];
  digest[12] = "5";
  digest[16] = "8";
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const fixtureLimits = Object.freeze({
  maxCompressedBytes: 1024 * 1024,
  maxUncompressedBytes: 4 * 1024 * 1024,
  maxEntries: 100,
  maxExpansionRatio: 100,
  maxManifestBytes: 1024 * 1024,
  maxJsonEntryBytes: 1024 * 1024,
  maxOriginalImageBytes: 1024 * 1024,
});
const databaseUrl = process.env.TEST_DATABASE_URL;
const releaseGate = process.platform === "linux"
  && databaseUrl
  && supportsSecureGeneratedArchiveStaging()
  ? it
  : it.skip;
const releaseChunkBytes = 1024 * 1024;
const representativeDomainCounts = Object.freeze({
  providers: 3,
  prompts: 3,
  worlds: 2,
  "world-versions": 3,
  "world-drafts": 2,
  campaigns: 2,
  turns: 3,
  "turn-corrections": 1,
  "campaign-state": 2,
  "campaign-history": 11,
  "canonical-facts": 1,
  chronicle: 2,
  illustrations: 2,
  imports: 1,
  "cost-events": 2,
  "activity-events": 1,
} satisfies Record<SystemArchiveDomain, number>);
const excludedSecretSentinels = Object.freeze([
  "fixture-user-sentinel",
  "fixture-password-sentinel",
  "api_key=query-secret-sentinel",
  "query-secret-sentinel",
  "configuration-password-sentinel",
  "configuration-token-sentinel",
  "encrypted-api-key-sentinel",
  "credential-nonce-sentinel",
  "credential-auth-tag-sentinel",
]);
const excludedOperationalSentinels = Object.freeze([
  "excluded-endpoint",
  "excluded-response",
  "release-model",
  "story-v1",
  sha256("excluded-chain"),
  "excluded-release-job",
  "Excluded job",
  "fixture-failure",
  "excluded provider response",
  "excluded chronicle job",
  "excluded release chunk",
  sha256("excluded-share-link"),
]);
const excludedSecretAndOperationalSentinelVariants = Object.freeze([
  ...new Set([...excludedSecretSentinels, ...excludedOperationalSentinels].flatMap((sentinel) => {
    const encoded = encodeURIComponent(sentinel);
    const lowerPercentEncoding = encoded.replace(/%[0-9A-F]{2}/gu, (value) => value.toLowerCase());
    return [sentinel, encoded, lowerPercentEncoding];
  })),
]);
const representativeTimestamp = "2026-08-25T12:00:00.000Z";
const representativeTrackers = Object.freeze([
  Object.freeze({ id: "gate", name: "Gate", value: "open", rules: "Preserve" }),
]);

function expectNoSecretSentinels(value: unknown, surface: string): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  for (const sentinel of excludedSecretAndOperationalSentinelVariants) {
    expect(serialized, `${surface} must exclude ${sentinel}`).not.toContain(sentinel);
  }
}

function representativeStructuredProfile(role: string, note: string): ReturnType<typeof characterProfileSchema.parse> {
  const profile = characterProfileSchema.parse({});
  return {
    ...profile,
    identity: { aliases: ["The Gatekeeper"], pronouns: "they/them" },
    story: {
      ...profile.story,
      role,
      background: "Aster guards the portable release gate.",
      motivations: "Preserve every authoritative relationship.",
    },
    appearance: {
      ...profile.appearance,
      eyes: "silver",
      distinguishingFeatures: ["A luminous archive sigil"],
    },
    unclassifiedNotes: note,
  };
}

const previousCharacterProfile = Object.freeze({
  name: "Aster",
  profile: representativeStructuredProfile("Gate sentinel", "Profile before the portable edit."),
});
const currentCharacterProfile = Object.freeze({
  name: "Aster Vale",
  profile: representativeStructuredProfile("Archive steward", "Profile after the portable edit."),
});
const representativeCharacterSnapshot = Object.freeze({
  id: "release-hero",
  name: "Aster",
  characterText: "Aster guards the gate between installations.",
  profile: previousCharacterProfile.profile,
  rpgStats: [{ id: "resolve", name: "Resolve", value: 17, note: "Portable" }],
  defaultTriggers: [{ id: "sigil", name: "Sigil", value: "lit", rules: "Preserve" }],
  source: { type: "release-gate-fixture", revision: 7 },
});

function representativeWorldVersionContent(
  worldIndex: number,
  versionNumber: number,
  assets: readonly Readonly<{ assetId: string; role: "world_cover" | "world_version_asset" }>[] = [],
): ReturnType<typeof worldContentSchema.parse> {
  return worldContentSchema.parse({
    world: {
      title: `Release World ${worldIndex + 1}`,
      genre: "Archive fantasy",
      tone: "Exact",
      premise: `Portable world ${worldIndex + 1}, version ${versionNumber}.`,
      backgroundStory: "",
      firstAction: "Begin the release gate.",
      rules: "",
    },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets,
    defaults: { selectedCharacterId: null, initialLocation: "" },
  });
}

function representativeWorldDraftContent(worldIndex: number): ReturnType<typeof worldContentSchema.parse> {
  return worldContentSchema.parse({
    world: {
      title: `Release World ${worldIndex + 1}`,
      genre: "Archive fantasy",
      tone: "Draft",
      premise: `Editable draft ${worldIndex + 1}.`,
      backgroundStory: "",
      firstAction: "Revise.",
      rules: "",
    },
    playableCharacters: [],
    entities: [],
    relationships: [],
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    assets: [],
    defaults: { selectedCharacterId: null, initialLocation: "" },
  });
}

function representativeCampaignState(
  campaignIndex: number,
  canonicalFactId?: string,
): Record<string, unknown> {
  return {
    continuitySummary: `Continuity ${campaignIndex + 1}`,
    openThreads: [`Thread ${campaignIndex + 1}`],
    canonicalFacts: canonicalFactId === undefined
      ? []
      : [{ id: canonicalFactId, content: "The release gate is open." }],
    scratchpad: `Continuity ${campaignIndex + 1}`,
    trackers: representativeTrackers,
    rpgStats: [],
    defaultTriggers: [],
    eventTriggers: [],
    pendingEventTriggers: [],
  };
}

type StartedRuntime = Readonly<{
  baseUrl: string;
  logs(): string;
  stop(): Promise<void>;
}>;

type StartedWorker = Readonly<{
  logs(): string;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}>;

type SystemExportJobView = Extract<SystemArchiveJobView, { kind: "export" }>;

type RepresentativeProvider = Readonly<{
  id: string;
  kind: "text" | "image" | "embedding";
  displayName: string;
  baseUrl: string;
  selectedModel: string;
}>;

type RepresentativeAsset = Readonly<{
  id: string;
  contentHash: string;
  byteLength: number;
  pixelWidth: number;
  pixelHeight: number;
  title: string;
  reuseScope: "campaign" | "world" | "owner_library";
  favorite: boolean;
  archived: boolean;
  bindings: readonly ArchiveAssetBinding[];
}>;

type RepresentativeOwner = Readonly<{
  ownerUserId: string;
  worldIds: readonly string[];
  worldVersionIds: readonly string[];
  latestWorldVersionIds: readonly string[];
  campaignIds: readonly string[];
  turnIds: readonly string[];
  promptIds: readonly string[];
  providerIds: readonly string[];
  providers: readonly RepresentativeProvider[];
  turnSnapshots: readonly Readonly<Record<string, unknown>>[];
  characterProfileEditId: string;
  stateEditId: string;
  worldMigrationId: string;
  worldTransferId: string;
  correctionId: string;
  canonicalFactId: string;
  memoryId: string;
  summaryCheckpointId: string;
  checkpointOpenThreadId: string;
  importId: string;
  costEventIds: readonly string[];
  activitySourceId: string;
  illustrationSetId: string;
  illustrationSegmentId: string;
  assetIds: readonly string[];
  assets: readonly RepresentativeAsset[];
  originalHashes: readonly string[];
  expectedDomainCounts: Readonly<Record<SystemArchiveDomain, number>>;
}>;

type FrozenFixture = Readonly<{
  manifestBytes: Buffer;
  systemBytes: Buffer;
  assetsBytes: Buffer;
  archiveBytes: Buffer;
}>;

function processFailure(command: string, code: number | null, signal: NodeJS.Signals | null, output: string): Error {
  return new Error(`${command} failed (${signal ?? `exit ${code ?? "unknown"}`}):\n${output.slice(-20_000)}`);
}

async function runProcess(executable: string, argumentsList: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd: resolve("."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-100_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(processFailure(`${executable} ${argumentsList.join(" ")}`, code, signal, output));
    });
  });
}

let releaseBuild: Promise<void> | undefined;

async function buildReleaseArtifacts(): Promise<void> {
  const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  releaseBuild ??= runProcess(packageManager, ["build"]);
  await releaseBuild;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("system_archive_e2e_port_unavailable"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

async function waitForReady(baseUrl: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Compiled runtime exited before readiness:\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/meta`);
      if (response.ok) {
        const value = await response.json() as { capabilities?: { systemArchive?: boolean } };
        if (value.capabilities?.systemArchive === true) return;
      }
    } catch {
      // Startup races are expected until Fastify begins listening.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Compiled runtime did not become ready:\n${logs()}`);
}

function compiledRuntimeEnvironment(input: Readonly<{
  databaseUrl: string;
  archiveRoot: string;
  assetRoot: string;
  port: number;
  role: "api" | "all" | "worker";
  pollIntervalMs?: number;
}>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ROLE: input.role,
    APP_HOST: "127.0.0.1",
    APP_PORT: String(input.port),
    DATABASE_URL: input.databaseUrl,
    DATABASE_MAX_CONNECTIONS: "12",
    MIGRATION_DIRECTORY: resolve("database/migrations"),
    WORKER_POLL_INTERVAL_MS: String(input.pollIntervalMs ?? 250),
    WORKER_LEASE_SECONDS: "15",
    WORKER_GENERATION_CONCURRENCY: "1",
    LEGACY_WEB_ROOT: resolve("apps/web/dist"),
    NEXT_WEB_ROOT: resolve("apps/web-next/dist"),
    ASSET_STORAGE_ROOT: input.assetRoot,
    ARCHIVE_STORAGE_ROOT: input.archiveRoot,
    ARCHIVE_PREVIEW_TTL_SECONDS: "300",
    SYSTEM_ARCHIVE_ARTIFACT_TTL_SECONDS: "300",
    SYSTEM_ARCHIVE_ENABLED: "true",
    SYSTEM_ARCHIVE_UPLOAD_TTL_SECONDS: "300",
    SYSTEM_ARCHIVE_CHUNK_BYTES: String(releaseChunkBytes),
    SYSTEM_ARCHIVE_ALLOW_LIMIT_INCREASE: "false",
    SYSTEM_ARCHIVE_ALLOW_UNKNOWN_FREE_SPACE: "false",
    API_RATE_LIMIT_IMPORT_REQUESTS: "1000",
    API_CONCURRENCY_IMPORT_REQUESTS: "2",
    CREDENTIAL_ENCRYPTION_KEY: "system-archive-release-gate-only",
    LOG_LEVEL: input.role === "worker" ? "info" : "warn",
    NEXUS_VERSION: "0.1.0",
  };
}

async function startCompiledRuntime(input: Readonly<{
  databaseUrl: string;
  archiveRoot: string;
  assetRoot: string;
  port: number;
  role: "api" | "all";
}>): Promise<StartedRuntime> {
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const child = spawn(process.execPath, [resolve("dist/services/runtime/src/main.js")], {
    cwd: resolve("."),
    env: compiledRuntimeEnvironment({ ...input, role: input.role }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  await waitForReady(baseUrl, child, () => output);

  let stopped = false;
  return Object.freeze({
    baseUrl,
    logs: () => output,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 10_000)),
      ]);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  });
}

async function startCompiledWorker(input: Readonly<{
  databaseUrl: string;
  archiveRoot: string;
  assetRoot: string;
}>): Promise<StartedWorker> {
  const child = spawn(process.execPath, [resolve("dist/services/runtime/src/main.js")], {
    cwd: resolve("."),
    env: compiledRuntimeEnvironment({
      ...input,
      port: await freePort(),
      role: "worker",
      pollIntervalMs: 25,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer | string) => {
    output = `${output}${String(chunk)}`.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`Compiled worker exited during startup:\n${output}`);
  }

  let stopped = false;
  return Object.freeze({
    logs: () => output,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 10_000)),
      ]);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
    async terminate() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  });
}

async function jsonRequest<Result>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Result> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body}`);
  return JSON.parse(body) as Result;
}

type SystemJobState = Readonly<{
  status: string;
  lease_owner: string | null;
  lease_expired: boolean;
  progress: Record<string, unknown>;
  report: Record<string, unknown> | null;
}>;

async function waitForSystemJob(
  pool: DatabasePool,
  jobId: string,
  predicate: (state: SystemJobState) => boolean,
  description: string,
  logs: () => string,
  timeoutMs = 120_000,
): Promise<SystemJobState> {
  const deadline = Date.now() + timeoutMs;
  let last: SystemJobState | undefined;
  while (Date.now() < deadline) {
    const result = await pool.query<SystemJobState>(
      `SELECT status,lease_owner,
              lease_expires_at IS NOT NULL AND lease_expires_at<=clock_timestamp() AS lease_expired,
              progress,report
         FROM system_archive_jobs WHERE id=$1`,
      [jobId],
    );
    last = result.rows[0];
    expectNoSecretSentinels(last, `durable System Archive progress while waiting to ${description}`);
    if (last && predicate(last)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `Timed out waiting for System Archive job ${jobId} to ${description}; last=${JSON.stringify(last)}:\n${logs()}`,
  );
}

async function holdWorldExportRead(pool: DatabasePool): Promise<Readonly<{ release(): Promise<void> }>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE worlds IN ACCESS EXCLUSIVE MODE");
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  return Object.freeze({
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    },
  });
}

async function waitForBlockedWorldExportRead(
  pool: DatabasePool,
  logs: () => string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE relation='worlds'::regclass AND mode='AccessShareLock' AND NOT granted
       ) AS blocked`,
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`Timed out waiting for a compiled worker to block mid-export on worlds:\n${logs()}`);
}

async function putUploadChunk(
  baseUrl: string,
  uploadId: string,
  archive: Buffer,
  index: number,
  offset: number,
): Promise<{ id: string; status: string; byteLength: number; receivedBytes: number }> {
  const bytes = archive.subarray(offset, Math.min(offset + releaseChunkBytes, archive.byteLength));
  const progress = await jsonRequest<{ id: string; status: string; byteLength: number; receivedBytes: number }>(
    baseUrl,
    `/api/v1/system-imports/uploads/${uploadId}/chunks/${index}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "content-range": `bytes ${offset}-${offset + bytes.byteLength - 1}/${archive.byteLength}`,
        "x-chunk-sha256": sha256(bytes),
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    },
  );
  expectNoSecretSentinels(progress, `upload progress chunk ${index}`);
  return progress;
}

async function frozenFixture(): Promise<FrozenFixture> {
  const [manifestBytes, systemBytes, assetsBytes] = await Promise.all([
    readFile(resolve(fixtureRoot, "manifest.json")),
    readFile(resolve(fixtureRoot, "system.json")),
    readFile(resolve(fixtureRoot, "assets/assets.json")),
  ]);
  const zip = new JSZip();
  zip.file("manifest.json", manifestBytes);
  zip.file("system.json", systemBytes);
  zip.file("assets/assets.json", assetsBytes);
  const archiveBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    platform: "UNIX",
  });
  return Object.freeze({ manifestBytes, systemBytes, assetsBytes, archiveBytes });
}

async function importArchiveThroughApi(
  runtime: StartedRuntime,
  archive: Buffer,
): Promise<Readonly<{ id: string; status: string; report: Record<string, unknown> | null }>> {
  const upload = await jsonRequest<{ id: string }>(runtime.baseUrl, "/api/v1/system-imports/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ byteLength: archive.byteLength, sha256: sha256(archive) }),
  });
  expectNoSecretSentinels(upload, "frozen-fixture upload creation payload");
  let index = 0;
  for (let offset = 0; offset < archive.byteLength; offset += releaseChunkBytes) {
    await putUploadChunk(runtime.baseUrl, upload.id, archive, index, offset);
    index += 1;
  }
  const completedUpload = await jsonRequest<{ status: string }>(
    runtime.baseUrl,
    `/api/v1/system-imports/uploads/${upload.id}/complete`,
    { method: "POST" },
  );
  expect(completedUpload.status).toBe("completed");
  expectNoSecretSentinels(completedUpload, "frozen-fixture completed upload payload");
  const preview = await jsonRequest<{ valid: boolean; previewHandle: string | null }>(
    runtime.baseUrl,
    "/api/v1/system-imports/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId: upload.id }),
    },
  );
  expect(preview.valid).toBe(true);
  expect(preview.previewHandle).toEqual(expect.any(String));
  expectNoSecretSentinels(preview, "frozen-fixture import preview payload");
  const accepted = await jsonRequest<{ id: string }>(runtime.baseUrl, "/api/v1/system-imports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      previewHandle: preview.previewHandle,
      idempotencyKey: randomUUID(),
      acknowledgeSensitiveArchive: true,
      acknowledgeEmptyDestination: true,
      acknowledgeInvalidatedAccess: true,
      acknowledgeProviderReentry: true,
      acknowledgeNonCancellableBoundary: true,
    }),
  });
  expectNoSecretSentinels(accepted, "frozen-fixture accepted import payload");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await jsonRequest<{ id: string; status: string; report: Record<string, unknown> | null }>(
      runtime.baseUrl,
      `/api/v1/system-imports/${accepted.id}`,
    );
    expectNoSecretSentinels(job, "frozen-fixture import progress/report payload");
    if (job.status === "completed") {
      expectNoSecretSentinels(runtime.logs(), "frozen-fixture runtime and worker logs");
      return job;
    }
    if (["failed", "cancelled", "expired"].includes(job.status)) {
      throw new Error(`Frozen fixture import ended in ${job.status}:\n${runtime.logs()}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Frozen fixture import timed out:\n${runtime.logs()}`);
}

function databaseName(): string {
  return `infinitequest_system_release_${randomUUID().replaceAll("-", "")}`;
}

async function createDestinationDatabase(admin: DatabasePool, sourceUrl: string): Promise<Readonly<{
  name: string;
  url: string;
}>> {
  const name = databaseName();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  return Object.freeze({ name, url: url.toString() });
}

async function dropDestinationDatabase(admin: DatabasePool, name: string): Promise<void> {
  if (!/^infinitequest_system_release_[a-f0-9]{32}$/u.test(name)) {
    throw new Error("Refusing to drop an unexpected release-gate database.");
  }
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [name],
  );
  await admin.query(`DROP DATABASE ${name}`);
}

async function seedRepresentativeOwner(pool: DatabasePool, assetRoot: string): Promise<RepresentativeOwner> {
  await migrateDatabase(pool, resolve("database/migrations"));
  const ownerUserId = await initialOwnerId(pool);
  await pool.query("UPDATE users SET display_name='Release Gate Owner' WHERE id=$1", [ownerUserId]);

  const providerIds: string[] = [];
  const providers: RepresentativeProvider[] = [];
  for (const [displayName, role, baseUrl, portableBaseUrl] of [
    [
      "Release text",
      "text",
      "https://fixture-user-sentinel:fixture-password-sentinel@text.invalid/v1?api_key=query-secret-sentinel",
      "https://text.invalid/v1",
    ],
    ["Release image", "image", "https://image.invalid/v1", "https://image.invalid/v1"],
    ["Release embedding", "embedding", "https://embedding.invalid/v1", "https://embedding.invalid/v1"],
  ] as const) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model,
         request_timeout_ms,configuration,encrypted_api_key,credential_nonce,
         credential_auth_tag,credential_key_version,enabled,health_status
       ) VALUES ($1,$2,'openai_compatible',$3,$4,$5,321000,$6::jsonb,
                 'encrypted-api-key-sentinel','credential-nonce-sentinel',
                 'credential-auth-tag-sentinel',1,true,'healthy') RETURNING id`,
      [
        ownerUserId,
        displayName,
        role,
        baseUrl,
        `${role}-model`,
        JSON.stringify({
          retryLimit: 3,
          password: "configuration-password-sentinel",
          bearerToken: "configuration-token-sentinel",
        }),
      ],
    );
    const id = inserted.rows[0]!.id;
    providerIds.push(id);
    providers.push(Object.freeze({
      id,
      kind: role,
      displayName,
      baseUrl: portableBaseUrl,
      selectedModel: `${role}-model`,
    }));
  }
  const promptIds: string[] = [];
  const ownerPrompt = await pool.query<{ id: string }>(
    `INSERT INTO prompt_template_overrides (owner_user_id,prompt_key,content)
     VALUES ($1,'story_system','Owner-wide release prompt') RETURNING id`,
    [ownerUserId],
  );
  promptIds.push(ownerPrompt.rows[0]!.id);

  const worldIds: string[] = [];
  const worldVersionIds: string[] = [];
  const latestVersionByWorld = new Map<string, string>();
  for (const [worldIndex, versionCount] of [2, 1].entries()) {
    const title = `Release World ${worldIndex + 1}`;
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title,status) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, title, worldIndex === 0 ? "active" : "draft"],
    );
    const worldId = world.rows[0]!.id;
    worldIds.push(worldId);
    let latestVersionId = "";
    for (let versionNumber = 1; versionNumber <= versionCount; versionNumber += 1) {
      const content = representativeWorldVersionContent(worldIndex, versionNumber);
      const version = await pool.query<{ id: string }>(
        `INSERT INTO world_versions (
           world_id,owner_user_id,version_number,content,source_hash,release_notes,created_from_revision
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$3) RETURNING id`,
        [
          worldId,
          ownerUserId,
          versionNumber,
          JSON.stringify(content),
          sha256(`${worldId}:${versionNumber}`),
          `Release ${versionNumber}`,
        ],
      );
      latestVersionId = version.rows[0]!.id;
      worldVersionIds.push(latestVersionId);
    }
    latestVersionByWorld.set(worldId, latestVersionId);
    const draftContent = representativeWorldDraftContent(worldIndex);
    await pool.query(
      `INSERT INTO world_drafts (world_id,owner_user_id,based_on_world_version_id,revision,content)
       VALUES ($1,$2,$3,3,$4::jsonb)`,
      [worldId, ownerUserId, latestVersionId, JSON.stringify(draftContent)],
    );
  }

  await pool.query(
    `UPDATE worlds
        SET forked_from_world_id=$2,forked_from_world_version_id=$3
      WHERE id=$1 AND owner_user_id=$4`,
    [worldIds[1], worldIds[0], latestVersionByWorld.get(worldIds[0]!), ownerUserId],
  );

  const canonicalFactId = randomUUID();
  const campaignIds: string[] = [];
  const turnIds: string[] = [];
  const turnSnapshots: Readonly<Record<string, unknown>>[] = [];
  for (const [campaignIndex, worldId] of worldIds.entries()) {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id,world_version_id,title,active_turn_number,turn_control_style,
         selected_character_id,character_snapshot,character_profile,character_profile_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id`,
      [
        ownerUserId,
        latestVersionByWorld.get(worldId),
        `Release Campaign ${campaignIndex + 1}`,
        campaignIndex === 0 ? 2 : 1,
        campaignIndex === 0 ? "flexible_scene" : "flexible_action",
        campaignIndex === 0 ? representativeCharacterSnapshot.id : null,
        campaignIndex === 0 ? JSON.stringify(representativeCharacterSnapshot) : null,
        campaignIndex === 0 ? JSON.stringify(currentCharacterProfile) : null,
        campaignIndex === 0 ? 2 : 0,
      ],
    );
    const campaignId = campaign.rows[0]!.id;
    campaignIds.push(campaignId);
    await pool.query(
      `INSERT INTO campaign_state (
         campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
         event_triggers,pending_event_triggers,rpg_stats,revision
       ) VALUES ($1,$2,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,2)`,
      [campaignId, ownerUserId, `Continuity ${campaignIndex + 1}`, JSON.stringify(representativeTrackers)],
    );
    const campaignPrompt = await pool.query<{ id: string }>(
      `INSERT INTO prompt_template_overrides (owner_user_id,campaign_id,prompt_key,content)
       VALUES ($1,$2,'story_system',$3) RETURNING id`,
      [ownerUserId, campaignId, `Campaign prompt ${campaignIndex + 1}`],
    );
    promptIds.push(campaignPrompt.rows[0]!.id);
    const turnCount = campaignIndex === 0 ? 2 : 1;
    for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
      const stateSnapshot = Object.freeze(representativeCampaignState(
        campaignIndex,
        campaignIndex === 0 ? canonicalFactId : undefined,
      ));
      const turn = await pool.query<{ id: string }>(
        `INSERT INTO turns (
           owner_user_id,campaign_id,turn_number,action,narration,choices,image_prompt,
           input_mode,input_mode_source,state_snapshot_private,accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'scene','auto',$8::jsonb,
                   $9) RETURNING id`,
        [
          ownerUserId,
          campaignId,
          turnNumber,
          `Action ${campaignIndex + 1}.${turnNumber}`,
          `Narration ${campaignIndex + 1}.${turnNumber}`,
          JSON.stringify(["Continue"]),
          `Illustrate ${campaignIndex + 1}.${turnNumber}`,
          JSON.stringify(stateSnapshot),
          representativeTimestamp,
        ],
      );
      turnIds.push(turn.rows[0]!.id);
      turnSnapshots.push(stateSnapshot);
    }
  }

  const correction = await pool.query<{ id: string }>(
    `INSERT INTO turn_narration_corrections (
       owner_user_id,campaign_id,turn_id,revision,narration,
       previous_effective_narration_hash,reason,source,created_by_user_id
     ) VALUES ($1,$2,$3,1,'Corrected release narration',$4,
               'Release gate correction','user_edit',$1) RETURNING id`,
    [ownerUserId, campaignIds[0], turnIds[0], sha256("Narration 1.1")],
  );
  await pool.query(
    `INSERT INTO campaign_canonical_facts (
       id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,
       source_fact_index,content,normalized_content,valid_from_turn,valid_until_turn,metadata
     ) VALUES ($1,$2,$3,$4,$5,1,7,'The release gate is open.',
               'the release gate is open',1,3,$6::jsonb)`,
    [
      canonicalFactId,
      ownerUserId,
      campaignIds[0],
      latestVersionByWorld.get(worldIds[0]!),
      turnIds[0],
      JSON.stringify({ subject: "release gate", predicate: "status" }),
    ],
  );
  const characterProfileEdit = await pool.query<{ id: string }>(
    `INSERT INTO campaign_character_profile_edits (
       owner_user_id,campaign_id,revision,previous_profile,next_profile,edit_source
     ) VALUES ($1,$2,2,$3::jsonb,$4::jsonb,'manual') RETURNING id`,
    [
      ownerUserId,
      campaignIds[0],
      JSON.stringify(previousCharacterProfile),
      JSON.stringify(currentCharacterProfile),
    ],
  );
  const stateEdit = await pool.query<{ id: string }>(
    `INSERT INTO campaign_state_edits (
       owner_user_id,campaign_id,effective_turn_number,revision,state_snapshot_private,changed_fields
     ) VALUES ($1,$2,2,2,$3::jsonb,$4::jsonb) RETURNING id`,
    [
      ownerUserId,
      campaignIds[0],
      JSON.stringify(representativeCampaignState(0, canonicalFactId)),
      JSON.stringify(["canonicalFacts", "trackers"]),
    ],
  );
  const worldMigration = await pool.query<{ id: string }>(
    `INSERT INTO campaign_world_migrations (
       owner_user_id,campaign_id,from_world_version_id,to_world_version_id,note
     ) VALUES ($1,$2,$3,$4,'Promote the release campaign to version two.') RETURNING id`,
    [ownerUserId, campaignIds[0], worldVersionIds[0], worldVersionIds[1]],
  );
  const worldTransferId = randomUUID();
  await pool.query(
    `INSERT INTO campaign_world_transfers (
       id,owner_user_id,idempotency_key,source_campaign_id,target_campaign_id,
       from_world_version_id,to_world_version_id,character_strategy,state_strategy,
       target_defaults_policy,source_fingerprint,warnings,note
     ) VALUES ($1,$2,$1,$3,$4,$5,$6,'preserve_source','preserve','retain_source',$7,$8::jsonb,$9)`,
    [
      worldTransferId,
      ownerUserId,
      campaignIds[0],
      campaignIds[1],
      latestVersionByWorld.get(worldIds[0]!),
      latestVersionByWorld.get(worldIds[1]!),
      sha256("release-world-transfer"),
      JSON.stringify(["Release transfer warning"]),
      "Transfer the release campaign between worlds.",
    ],
  );
  await pool.query(
    `INSERT INTO campaign_memory_configs (
       campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,
       embedding_model,embedding_batch_size
     ) VALUES ($1,$2,true,$3,'release-embedding',24)`,
    [campaignIds[0], ownerUserId, providerIds[2]],
  );
  await pool.query(
    `INSERT INTO campaign_illustration_configs (
       campaign_id,owner_user_id,enabled,provider_profile_id,model,size,aspect_ratio,
       quality,output_format,max_attempts,source_policy,matching_scope,confidence_profile,
       repetition_window,segment_word_count,images_per_segment,segment_prompt_mode,
       refinement_prompt
     ) VALUES ($1,$2,true,$3,'image-model','1536x1024','3:2','high','webp',4,
               'library_then_generate','campaign','strict',9,250,2,'ai_refined',
               'Preserve the fiction-only release aesthetic.')`,
    [campaignIds[0], ownerUserId, providerIds[1]],
  );
  const memory = await pool.query<{ id: string }>(
    `INSERT INTO chronicle_memories (
       owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,ordinal,
       content,token_estimate,entities,metadata
     ) VALUES ($1,$2,$3,$4,'turn_fiction',1,'Release memory',3,ARRAY['Gate'],'{}'::jsonb)
     RETURNING id`,
    [ownerUserId, campaignIds[0], latestVersionByWorld.get(worldIds[0]!), turnIds[0]],
  );
  await pool.query(
    `UPDATE chronicle_memories
        SET embedding='[0.1,0.2,0.3]'::vector,
            embedding_provider_profile_id=$2,
            embedding_model='release-embedding',embedding_dimensions=3,
            embedding_content_hash=content_hash,embedding_updated_at=now(),
            embedding_provider_fingerprint='release-fingerprint'
      WHERE id=$1`,
    [memory.rows[0]!.id, providerIds[2]],
  );
  const checkpointOpenThreadId = randomUUID();
  const summaryCheckpoint = await pool.query<{ id: string }>(
    `INSERT INTO summary_checkpoints (
       owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate
     ) VALUES ($1,$2,2,'campaign_summary',$3::jsonb,4) RETURNING id`,
    [
      ownerUserId,
      campaignIds[0],
      JSON.stringify({ summary: "Release summary", openThreadIds: [checkpointOpenThreadId] }),
    ],
  );
  await pool.query(
    `INSERT INTO chronicle_memory_chunks (
       owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
       chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,
       source_end_offset,token_estimate
     ) SELECT owner_user_id,campaign_id,world_version_id,id,content_hash,
              'chunk-v2',0,'turn_narration','excluded release chunk',0,22,4
         FROM chronicle_memories WHERE id=$1`,
    [memory.rows[0]!.id],
  );
  const importProvenance = await pool.query<{ id: string }>(
    `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status,campaign_id,completed_at)
     VALUES ($1,'legacy_story','Release source',$2,'completed',$3,now()) RETURNING id`,
    [ownerUserId, sha256("release-source"), campaignIds[0]],
  );
  const costEventIds: string[] = [];
  for (const [index, category] of ["story", "image"].entries()) {
    const cost = await pool.query<{ id: string }>(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_profile_id,provider_type,category,
         operation,amount,currency
       ) VALUES ($1,$2,$3,$4,'openai_compatible',$5,'response',$6,'USD') RETURNING id`,
      [
        ownerUserId,
        campaignIds[index]!,
        turnIds[index === 0 ? 0 : 2]!,
        providerIds[index]!,
        category,
        index === 0 ? 0.01 : 0.02,
      ],
    );
    costEventIds.push(cost.rows[0]!.id);
  }
  const activity = await pool.query<{ id: string }>(
    `INSERT INTO activity_events (owner_user_id,campaign_id,event_type,details)
     VALUES ($1,$2,'campaign.accepted_turn',$3::jsonb) RETURNING id::text AS id`,
    [ownerUserId, campaignIds[0], JSON.stringify({ summary: "Release activity" })],
  );
  const activityHex = BigInt(activity.rows[0]!.id).toString(16).padStart(12, "0").slice(-12);
  const activitySourceId = `00000000-0000-4000-8000-${activityHex}`;

  await pool.query(
    `INSERT INTO world_share_links (owner_user_id,world_id,world_version_id,token_hash,expires_at)
     VALUES ($1,$2,$3,$4,now()+interval '1 day')`,
    [ownerUserId, worldIds[0], latestVersionByWorld.get(worldIds[0]!), sha256("excluded-share-link")],
  );
  await pool.query(
    `INSERT INTO model_chains (
       owner_user_id,campaign_id,world_version_id,provider_profile_id,model,
       endpoint_identity,prompt_protocol_version,context_fingerprint,previous_response_id
     ) VALUES ($1,$2,$3,$4,'release-model','excluded-endpoint','story-v1',$5,'excluded-response')`,
    [ownerUserId, campaignIds[0], latestVersionByWorld.get(worldIds[0]!), providerIds[0], sha256("excluded-chain")],
  );
  await pool.query(
    `INSERT INTO generation_jobs (
       owner_user_id,campaign_id,provider_profile_id,idempotency_key,
       expected_turn_number,action,status,error_code,error_message,completed_at
     ) VALUES ($1,$2,$3,'excluded-release-job',3,'Excluded job','failed',
               'fixture-failure','excluded provider response',now())`,
    [ownerUserId, campaignIds[0], providerIds[0]],
  );
  await pool.query(
    `INSERT INTO chronicle_jobs (
       owner_user_id,campaign_id,job_type,status,error_message,completed_at
     ) VALUES ($1,$2,'reindex_campaign','failed','excluded chronicle job',now())`,
    [ownerUserId, campaignIds[0]],
  );

  const originalHashes: string[] = [];
  const originalDimensions: Array<Readonly<{ byteLength: number; pixelWidth: number; pixelHeight: number }>> = [];
  const largeRaw = randomBytes(2_200 * 2_200 * 4);
  const originals = await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer(),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#00ff00" } }).png().toBuffer(),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#0000ff" } }).png().toBuffer(),
    sharp(largeRaw, { raw: { width: 2_200, height: 2_200, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer(),
  ]);
  const assetIds: string[] = [];
  const titles = ["cover", "selected", "alternate", "unbound-archived"] as const;
  for (const [index, bytes] of originals.entries()) {
    const contentHash = sha256(bytes);
    originalHashes.push(contentHash);
    const storagePath = `originals/${contentHash}.png`;
    const absolutePath = join(assetRoot, storagePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    const metadata = await sharp(bytes).metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
      throw new Error("Representative original lacks image dimensions.");
    }
    originalDimensions.push(Object.freeze({
      byteLength: bytes.byteLength,
      pixelWidth: metadata.width,
      pixelHeight: metadata.height,
    }));
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id,content_hash,storage_driver,storage_path,mime_type,byte_length,
         pixel_width,pixel_height,technical_metadata
       ) VALUES ($1,$2,'filesystem',$3,'image/png',$4,$5,$6,'{}'::jsonb) RETURNING id`,
      [ownerUserId, contentHash, storagePath, bytes.byteLength, metadata.width, metadata.height],
    );
    assetIds.push(inserted.rows[0]!.id);
    await pool.query(
      `UPDATE asset_library_entries
          SET title=$3,reuse_scope=$4,review_status='eligible',favorite=$5,
              archived_at=CASE WHEN $3='unbound-archived' THEN created_at ELSE NULL END
        WHERE owner_user_id=$1 AND asset_id=$2`,
      [
        ownerUserId,
        inserted.rows[0]!.id,
        titles[index],
        index === 3 ? "owner_library" : index === 0 ? "world" : "campaign",
        index === 1,
      ],
    );
  }
  await pool.query("UPDATE worlds SET cover_asset_id=$2 WHERE id=$1", [worldIds[0], assetIds[0]]);
  await pool.query(
    `UPDATE world_versions
        SET content=jsonb_set(content,'{assets}',$2::jsonb,true)
      WHERE id=$1`,
    [latestVersionByWorld.get(worldIds[0]!), JSON.stringify([
      { assetId: assetIds[0], role: "world_cover" },
      { assetId: assetIds[1], role: "world_version_asset" },
    ])],
  );
  const illustrationSet = await pool.query<{ id: string }>(
    `INSERT INTO turn_illustration_sets (
       owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,
       images_per_segment,prompt_mode,status,is_active,completed_at
     ) VALUES ($1,$2,$3,$4,100,2,'direct','completed',true,now()) RETURNING id`,
    [ownerUserId, campaignIds[0], turnIds[0], sha256("Narration 1.1")],
  );
  const segment = await pool.query<{ id: string }>(
    `INSERT INTO turn_illustration_segments (
       owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,
       end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,
       resolved_prompt,prompt_source,status
     ) VALUES ($1,$2,$3,$4,0,0,13,0,2,'Narration 1.1',$5,
               'Release gate','Release gate','direct','completed') RETURNING id`,
    [ownerUserId, illustrationSet.rows[0]!.id, campaignIds[0], turnIds[0], sha256("Narration 1.1")],
  );
  await pool.query(
    `INSERT INTO turn_illustration_segment_assets (segment_id,owner_user_id,asset_id,variant_index)
     VALUES ($1,$2,$3,0),($1,$2,$4,1)`,
    [segment.rows[0]!.id, ownerUserId, assetIds[1], assetIds[2]],
  );

  const timestampUpdates = [
    "UPDATE prompt_template_overrides SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE worlds SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE world_versions SET created_at=$1,published_at=$1 WHERE owner_user_id=$2",
    "UPDATE world_drafts SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaigns SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE turns SET created_at=$1,accepted_at=$1 WHERE owner_user_id=$2",
    "UPDATE turn_narration_corrections SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_state SET updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_character_profile_edits SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_state_edits SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_world_migrations SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_world_transfers SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_memory_configs SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_illustration_configs SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE campaign_canonical_facts SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE chronicle_memories SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE summary_checkpoints SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE imports SET created_at=$1,completed_at=$1 WHERE owner_user_id=$2",
    "UPDATE provider_cost_events SET occurred_at=$1,created_at=$1 WHERE owner_user_id=$2",
    "UPDATE activity_events SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE turn_illustration_sets SET created_at=$1,completed_at=$1 WHERE owner_user_id=$2",
    "UPDATE turn_illustration_segments SET created_at=$1,updated_at=$1 WHERE owner_user_id=$2",
    "UPDATE turn_illustration_segment_assets SET created_at=$1 WHERE owner_user_id=$2",
    "UPDATE assets SET created_at=$1 WHERE owner_user_id=$2",
    `UPDATE asset_library_entries
        SET created_at=$1,updated_at=$1,archived_at=CASE WHEN archived_at IS NULL THEN NULL ELSE $1 END
      WHERE owner_user_id=$2`,
  ] as const;
  for (const update of timestampUpdates) {
    await pool.query(update, [representativeTimestamp, ownerUserId]);
  }

  const latestWorldVersionIds = worldIds.map((worldId) => latestVersionByWorld.get(worldId)!);
  const assets: RepresentativeAsset[] = [
    Object.freeze({
      id: assetIds[0]!,
      contentHash: originalHashes[0]!,
      ...originalDimensions[0]!,
      title: titles[0],
      reuseScope: "world",
      favorite: false,
      archived: false,
      bindings: Object.freeze([
        { role: "world_cover", worldId: worldIds[0]! },
        {
          role: "world_version_asset",
          worldId: worldIds[0]!,
          worldVersionId: latestWorldVersionIds[0]!,
        },
      ] satisfies ArchiveAssetBinding[]),
    }),
    Object.freeze({
      id: assetIds[1]!,
      contentHash: originalHashes[1]!,
      ...originalDimensions[1]!,
      title: titles[1],
      reuseScope: "campaign",
      favorite: true,
      archived: false,
      bindings: Object.freeze([
        {
          role: "world_version_asset",
          worldId: worldIds[0]!,
          worldVersionId: latestWorldVersionIds[0]!,
        },
        {
          role: "illustration_segment_variant",
          campaignId: campaignIds[0]!,
          turnId: turnIds[0]!,
          segmentId: segment.rows[0]!.id,
          variantIndex: 0,
        },
      ] satisfies ArchiveAssetBinding[]),
    }),
    Object.freeze({
      id: assetIds[2]!,
      contentHash: originalHashes[2]!,
      ...originalDimensions[2]!,
      title: titles[2],
      reuseScope: "campaign",
      favorite: false,
      archived: false,
      bindings: Object.freeze([{
        role: "illustration_segment_variant",
        campaignId: campaignIds[0]!,
        turnId: turnIds[0]!,
        segmentId: segment.rows[0]!.id,
        variantIndex: 1,
      }] satisfies ArchiveAssetBinding[]),
    }),
    Object.freeze({
      id: assetIds[3]!,
      contentHash: originalHashes[3]!,
      ...originalDimensions[3]!,
      title: titles[3],
      reuseScope: "owner_library",
      favorite: false,
      archived: true,
      bindings: Object.freeze([]),
    }),
  ];

  return Object.freeze({
    ownerUserId,
    worldIds: Object.freeze(worldIds),
    worldVersionIds: Object.freeze(worldVersionIds),
    latestWorldVersionIds: Object.freeze(latestWorldVersionIds),
    campaignIds: Object.freeze(campaignIds),
    turnIds: Object.freeze(turnIds),
    promptIds: Object.freeze(promptIds),
    providerIds: Object.freeze(providerIds),
    providers: Object.freeze(providers),
    turnSnapshots: Object.freeze(turnSnapshots),
    characterProfileEditId: characterProfileEdit.rows[0]!.id,
    stateEditId: stateEdit.rows[0]!.id,
    worldMigrationId: worldMigration.rows[0]!.id,
    worldTransferId,
    correctionId: correction.rows[0]!.id,
    canonicalFactId,
    memoryId: memory.rows[0]!.id,
    summaryCheckpointId: summaryCheckpoint.rows[0]!.id,
    checkpointOpenThreadId,
    importId: importProvenance.rows[0]!.id,
    costEventIds: Object.freeze(costEventIds),
    activitySourceId,
    illustrationSetId: illustrationSet.rows[0]!.id,
    illustrationSegmentId: segment.rows[0]!.id,
    assetIds: Object.freeze(assetIds),
    assets: Object.freeze(assets),
    originalHashes: Object.freeze(originalHashes),
    expectedDomainCounts: representativeDomainCounts,
  });
}

async function createExportThroughPage(page: Page): Promise<SystemExportJobView> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/system-exports" && response.request().method() === "POST";
  });
  await page.locator('[data-action="create-system-export"]').click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const job = systemArchiveJobViewSchema.parse(await response.json());
  if (job.kind !== "export") throw new Error("Replacement UI created a non-export System Archive job.");
  expectNoSecretSentinels(job, "queued export API job payload");
  await page.getByText(`System Export: ${job.status.replaceAll("_", " ")}.`, { exact: true }).waitFor();
  return job;
}

async function exportThroughReplacementUi(
  browser: Browser,
  runtime: StartedRuntime,
  databaseUrl: string,
  archiveRoot: string,
  assetRoot: string,
  downloadPath: string,
): Promise<SystemExportJobView> {
  const pool = createDatabasePool(databaseUrl, 6);
  const workerInput = { databaseUrl, archiveRoot, assetRoot } as const;

  const cancellationContext = await browser.newContext({ acceptDownloads: true });
  let cancellationWorker: StartedWorker | undefined;
  try {
    const cancellationPage = await cancellationContext.newPage();
    await cancellationPage.goto(`${runtime.baseUrl}/app/data-transfer`);
    const job = await createExportThroughPage(cancellationPage);
    expect(job.status).toBe("queued");

    const cancellationResponse = cancellationPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/v1/system-exports/${job.id}` && response.request().method() === "DELETE";
    });
    await cancellationPage.locator('[data-action="cancel-system-operation"]').click();
    const cancelling = systemArchiveJobViewSchema.parse(await (await cancellationResponse).json());
    expect(cancelling).toMatchObject({ id: job.id, kind: "export", status: "cancelling" });
    expectNoSecretSentinels(cancelling, "cancelling export API job payload");

    cancellationWorker = await startCompiledWorker(workerInput);
    const cancelledState = await waitForSystemJob(
      pool,
      job.id,
      (state) => state.status === "cancelled" && state.lease_owner === null,
      "reach durable cancellation",
      cancellationWorker.logs,
    );
    expect(cancelledState).toMatchObject({ status: "cancelled", lease_owner: null });
    const durableCancelled = systemArchiveJobViewSchema.parse(
      await jsonRequest(runtime.baseUrl, `/api/v1/system-exports/${job.id}`),
    );
    expect(durableCancelled).toMatchObject({ id: job.id, kind: "export", status: "cancelled" });
    expectNoSecretSentinels(durableCancelled, "cancelled export API job payload");
    await cancellationPage.reload();
    await cancellationPage.getByText("System Export: cancelled.", { exact: true }).waitFor();
    expectNoSecretSentinels(await cancellationPage.locator("body").textContent(), "rendered cancelled export output");
    expectNoSecretSentinels(runtime.logs(), "source runtime cancellation logs");
    expectNoSecretSentinels(cancellationWorker.logs(), "cancellation worker logs");
  } catch (error) {
    throw new Error(
      `Replacement UI durable cancellation failed:\n${runtime.logs()}\n${cancellationWorker?.logs() ?? ""}`,
      { cause: error },
    );
  } finally {
    await cancellationWorker?.stop().catch(() => undefined);
    await cancellationContext.close();
  }

  const durableContext = await browser.newContext({ acceptDownloads: true });
  let firstWorker: StartedWorker | undefined;
  let replacementWorker: StartedWorker | undefined;
  let firstBlocker: Awaited<ReturnType<typeof holdWorldExportRead>> | undefined;
  let replacementBlocker: Awaited<ReturnType<typeof holdWorldExportRead>> | undefined;
  let terminatedWorkerLogs = "";
  try {
    const page = await durableContext.newPage();
    await page.goto(`${runtime.baseUrl}/app/data-transfer`);
    const job = await createExportThroughPage(page);
    expect(job.status).toBe("queued");

    firstBlocker = await holdWorldExportRead(pool);
    firstWorker = await startCompiledWorker(workerInput);
    const firstClaim = await waitForSystemJob(
      pool,
      job.id,
      (state) => state.status === "capturing" && state.lease_owner !== null,
      "be claimed by the first worker",
      firstWorker.logs,
    );
    const firstLeaseOwner = firstClaim.lease_owner!;
    await waitForBlockedWorldExportRead(pool, firstWorker.logs);
    await firstWorker.terminate();
    terminatedWorkerLogs = firstWorker.logs();
    firstWorker = undefined;

    const abandoned = await waitForSystemJob(
      pool,
      job.id,
      (state) => state.status === "capturing" && state.lease_owner === firstLeaseOwner,
      "retain the terminated worker lease",
      runtime.logs,
    );
    expect(abandoned).toMatchObject({ status: "capturing", lease_owner: firstLeaseOwner });
    await firstBlocker.release();
    firstBlocker = undefined;

    await waitForSystemJob(
      pool,
      job.id,
      (state) => state.lease_owner === firstLeaseOwner && state.lease_expired,
      "expire the terminated worker lease by PostgreSQL time",
      runtime.logs,
      45_000,
    );

    replacementBlocker = await holdWorldExportRead(pool);
    replacementWorker = await startCompiledWorker(workerInput);
    const reclaimed = await waitForSystemJob(
      pool,
      job.id,
      (state) => state.status === "capturing"
        && state.lease_owner !== null
        && state.lease_owner !== firstLeaseOwner,
      "be reclaimed by a distinct replacement worker",
      replacementWorker.logs,
    );
    expect(reclaimed.lease_owner).not.toBe(firstLeaseOwner);
    await waitForBlockedWorldExportRead(pool, replacementWorker.logs);
    await replacementBlocker.release();
    replacementBlocker = undefined;

    const downloadLink = page.locator("[data-system-download]");
    await downloadLink.waitFor({ state: "visible", timeout: 120_000 });
    const published = systemArchiveJobViewSchema.parse(
      await jsonRequest(runtime.baseUrl, `/api/v1/system-exports/${job.id}`),
    );
    if (published.kind !== "export") throw new Error("Replacement UI recovered a non-export job.");
    expect(published.status).toBe("published");
    const durable = await pool.query<{
      progress: Record<string, unknown>;
      report: Record<string, unknown> | null;
    }>(
      "SELECT progress,report FROM system_archive_jobs WHERE id=$1 AND kind='export'",
      [job.id],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]!.report).toEqual(published.report);
    expectNoSecretSentinels(durable.rows[0], "durable export database progress and report");
    expectNoSecretSentinels(durable.rows[0]!.report?.warnings, "durable export warnings");
    expectNoSecretSentinels(durable.rows[0]!.report?.errors, "durable export errors");
    expectNoSecretSentinels(runtime.logs(), "source runtime export logs");
    expectNoSecretSentinels(terminatedWorkerLogs, "terminated export worker logs");
    expectNoSecretSentinels(replacementWorker.logs(), "replacement export worker logs");
    expectNoSecretSentinels(await page.locator("body").textContent(), "rendered published export output");
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await downloadLink.click();
    const download = await downloadPromise;
    await download.saveAs(downloadPath);
    return published;
  } catch (error) {
    throw new Error(
      `Replacement UI worker termination/reclaim export failed:\n${runtime.logs()}\n`
      + `${terminatedWorkerLogs}\n${firstWorker?.logs() ?? ""}\n${replacementWorker?.logs() ?? ""}`,
      { cause: error },
    );
  } finally {
    await firstBlocker?.release().catch(() => undefined);
    await replacementBlocker?.release().catch(() => undefined);
    await firstWorker?.stop().catch(() => undefined);
    await replacementWorker?.stop().catch(() => undefined);
    await durableContext.close();
    await pool.end();
  }
}

function assertRoundThreeArchiveRelationships(
  records: readonly SystemRecordEnvelope[],
  source: RepresentativeOwner,
): void {
  for (const [index, turnId] of source.turnIds.entries()) {
    const turn = records.find((entry) => entry.domain === "turns" && entry.sourceId === turnId);
    const portableTurn = turn?.record as unknown as Record<string, unknown> | undefined;
    expect(portableTurn?.stateSnapshotPrivate, `turn ${turnId} must archive its exact private state snapshot`)
      .toEqual(source.turnSnapshots[index]);
  }

  const fact = records.find((entry) => entry.domain === "canonical-facts"
    && entry.sourceId === source.canonicalFactId)?.record as unknown as Record<string, unknown> | undefined;
  expect(fact, "canonical fact must retain exact turn/index/validity provenance").toMatchObject({
    sourceTurnId: source.turnIds[0],
    sourceTurnNumber: 1,
    sourceFactIndex: 7,
    validFromTurn: 1,
    validUntilTurn: 3,
    supersededByFactId: null,
  });

  const provenance = records.find((entry) => entry.domain === "imports"
    && entry.sourceId === source.importId)?.record as unknown as Record<string, unknown> | undefined;
  expect(provenance?.campaignId, "import provenance must retain its campaign relationship")
    .toBe(source.campaignIds[0]);

  const fork = records.find((entry) => entry.domain === "worlds"
    && entry.sourceId === source.worldIds[1])?.record as unknown as Record<string, unknown> | undefined;
  expect(fork, "forked world must retain exact source world/version provenance").toMatchObject({
    forkedFromWorldId: source.worldIds[0],
    forkedFromWorldVersionId: source.latestWorldVersionIds[0],
  });

  const campaign = records.find((entry) => entry.domain === "campaigns"
    && entry.sourceId === source.campaignIds[0])?.record as unknown as Record<string, unknown> | undefined;
  expect(campaign, "campaign must retain selected-character and structured-profile authority").toMatchObject({
    selectedCharacterId: representativeCharacterSnapshot.id,
    characterSnapshot: representativeCharacterSnapshot,
    characterProfile: currentCharacterProfile,
    characterProfileRevision: 2,
  });

  const history = records.filter((entry) => entry.domain === "campaign-history");
  const historyBySource = (sourceId: string): Extract<SystemRecordEnvelope, { domain: "campaign-history" }> | undefined => (
    history.find((entry) => entry.sourceId === sourceId) as
      | Extract<SystemRecordEnvelope, { domain: "campaign-history" }>
      | undefined
  );
  const assertHistory = (
    sourceId: string,
    campaignId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): void => {
    const event = historyBySource(sourceId);
    expect(event?.record).toEqual({
      sourceId,
      campaignId,
      eventType,
      content: event?.record.content,
      occurredAt: representativeTimestamp,
    });
    expect(JSON.parse(event!.record.content)).toEqual(content);
  };

  assertHistory(source.characterProfileEditId, source.campaignIds[0]!, "character-profile-edit", {
    revision: 2,
    previousProfile: previousCharacterProfile,
    nextProfile: currentCharacterProfile,
    editSource: "manual",
  });
  assertHistory(source.stateEditId, source.campaignIds[0]!, "campaign-state-edit", {
    effectiveTurnNumber: 2,
    revision: 2,
    stateSnapshot: representativeCampaignState(0, source.canonicalFactId),
    changedFields: ["canonicalFacts", "trackers"],
  });
  assertHistory(source.worldMigrationId, source.campaignIds[0]!, "world-migration", {
    fromWorldVersionId: source.worldVersionIds[0],
    toWorldVersionId: source.worldVersionIds[1],
    note: "Promote the release campaign to version two.",
  });
  assertHistory(source.worldTransferId, source.campaignIds[1]!, "world-transfer", {
    sourceCampaignId: source.campaignIds[0],
    targetCampaignId: source.campaignIds[1],
    fromWorldVersionId: source.latestWorldVersionIds[0],
    toWorldVersionId: source.latestWorldVersionIds[1],
    characterStrategy: "preserve_source",
    stateStrategy: "preserve",
    targetDefaultsPolicy: "retain_source",
    sourceFingerprint: sha256("release-world-transfer"),
    warnings: ["Release transfer warning"],
    note: "Transfer the release campaign between worlds.",
  });

  const memoryConfig = history.find((entry) => entry.domain === "campaign-history"
    && entry.record.eventType === "memory-config");
  expect(memoryConfig?.record).toEqual({
    sourceId: deterministicHistorySourceId("memory-config", source.campaignIds[0]!),
    campaignId: source.campaignIds[0],
    eventType: "memory-config",
    content: memoryConfig?.record.content,
    occurredAt: representativeTimestamp,
  });
  expect(JSON.parse(memoryConfig!.record.content)).toEqual({
    embeddingEnabled: true,
    embeddingProviderProfileId: source.providerIds[2],
    embeddingModel: "release-embedding",
    embeddingBatchSize: 24,
  });

  const illustrationConfig = history.find((entry) => entry.domain === "campaign-history"
    && entry.record.eventType === "illustration-config");
  expect(illustrationConfig?.record).toEqual({
    sourceId: deterministicHistorySourceId("illustration-config", source.campaignIds[0]!),
    campaignId: source.campaignIds[0],
    eventType: "illustration-config",
    content: illustrationConfig?.record.content,
    occurredAt: representativeTimestamp,
  });
  expect(JSON.parse(illustrationConfig!.record.content)).toEqual({
    enabled: true,
    providerProfileId: source.providerIds[1],
    model: "image-model",
    size: "1536x1024",
    aspectRatio: "3:2",
    quality: "high",
    outputFormat: "webp",
    maxAttempts: 4,
    sourcePolicy: "library_then_generate",
    matchingScope: "campaign",
    confidenceProfile: "strict",
    repetitionWindow: 9,
    segmentWordCount: 250,
    imagesPerSegment: 2,
    segmentPromptMode: "ai_refined",
    refinementPrompt: "Preserve the fiction-only release aesthetic.",
  });
}

async function assertRepresentativeArchive(
  archive: Buffer,
  published: SystemExportJobView,
  source: RepresentativeOwner,
): Promise<void> {
  expect(published.status).toBe("published");
  if (!published.report) throw new Error("Published System Archive export lacks its durable report.");
  expectNoSecretSentinels(published, "published export API job and report");
  expectNoSecretSentinels(published.report, "export report");
  expectNoSecretSentinels(published.report.warnings, "export warnings");
  expectNoSecretSentinels(published.report.errors, "export errors");
  expect(published.report.recordsByDomain).toEqual(source.expectedDomainCounts);
  expect(published.report.assetCount).toBe(source.assets.length);
  expect(published.report.operationalOmissions).toMatchObject({
    generation: expect.any(Number),
    chronicle: expect.any(Number),
    "system-archive": expect.any(Number),
  });

  const zip = await JSZip.loadAsync(archive);
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const serialized = Buffer.concat(await Promise.all(files.map((entry) => entry.async("nodebuffer")))).toString("utf8");
  expectNoSecretSentinels(serialized, "archive payloads and originals");

  const manifestEntry = zip.file("manifest.json");
  const systemEntry = zip.file("system.json");
  const assetsEntry = zip.file("assets/assets.json");
  if (!manifestEntry || !systemEntry || !assetsEntry) throw new Error("Representative archive lacks a required logical payload.");
  const manifest = systemArchiveManifestSchema.parse(JSON.parse(await manifestEntry.async("string")));
  const systemPayload = systemArchivePayloadSchema.parse(JSON.parse(await systemEntry.async("string")));
  const assetPayload = systemArchiveAssetsPayloadSchema.parse(JSON.parse(await assetsEntry.async("string")));
  expect(manifest).toMatchObject({
    archiveType: "system",
    sourceInstallationId: source.ownerUserId,
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: source.ownerUserId, displayName: "Release Gate Owner" },
    assets: expect.any(Array),
  });
  expect(systemPayload).toMatchObject({
    sourceOwnerCount: 1,
    sourceOwner: { sourceId: source.ownerUserId, displayName: "Release Gate Owner" },
    records: [],
  });
  expect(manifest.assets).toEqual(assetPayload.assets);

  const records: SystemRecordEnvelope[] = [];
  for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
    const entries = files
      .filter((entry) => entry.name.startsWith(`records/${domain}/`))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const lines = (await entry.async("string")).trim().split("\n").filter(Boolean);
      records.push(...lines.map((line) => systemRecordEnvelopeSchema.parse(JSON.parse(line))));
    }
  }
  const actualDomainCounts = Object.fromEntries(SYSTEM_ARCHIVE_DOMAINS.map((domain) => [
    domain,
    records.filter((record) => record.domain === domain).length,
  ])) as Record<SystemArchiveDomain, number>;
  expect(actualDomainCounts).toEqual(source.expectedDomainCounts);
  assertRoundThreeArchiveRelationships(records, source);

  const providers = records.filter((entry) => entry.domain === "providers");
  expect(providers).toHaveLength(3);
  for (const expected of source.providers) {
    expect(providers.find((entry) => entry.sourceId === expected.id)?.record).toEqual({
      sourceId: expected.id,
      kind: expected.kind,
      displayName: expected.displayName,
      baseUrl: expected.baseUrl,
      selectedModel: expected.selectedModel,
      contextWindow: 32768,
      timeoutMs: 321000,
      retryLimit: 3,
      enabled: false,
      health: "unknown",
    });
  }

  const prompts = records.filter((entry) => entry.domain === "prompts");
  expect(prompts.map((entry) => entry.record)).toEqual(expect.arrayContaining([
    {
      sourceId: source.promptIds[0],
      campaignId: null,
      templateKey: "story_system",
      overrideText: "Owner-wide release prompt",
      updatedAt: representativeTimestamp,
    },
    {
      sourceId: source.promptIds[1],
      campaignId: source.campaignIds[0],
      templateKey: "story_system",
      overrideText: "Campaign prompt 1",
      updatedAt: representativeTimestamp,
    },
    {
      sourceId: source.promptIds[2],
      campaignId: source.campaignIds[1],
      templateKey: "story_system",
      overrideText: "Campaign prompt 2",
      updatedAt: representativeTimestamp,
    },
  ]));

  const worlds = records.filter((entry) => entry.domain === "worlds");
  expect(worlds.map((entry) => entry.record)).toEqual(expect.arrayContaining([
    {
      sourceId: source.worldIds[0], title: "Release World 1", status: "active",
      forkedFromWorldId: null, forkedFromWorldVersionId: null,
      createdAt: representativeTimestamp, updatedAt: representativeTimestamp,
    },
    {
      sourceId: source.worldIds[1], title: "Release World 2", status: "draft",
      forkedFromWorldId: source.worldIds[0],
      forkedFromWorldVersionId: source.latestWorldVersionIds[0],
      createdAt: representativeTimestamp, updatedAt: representativeTimestamp,
    },
  ]));
  const versions = records.filter((entry) => entry.domain === "world-versions");
  for (const [index, versionId] of source.worldVersionIds.entries()) {
    const worldIndex = index < 2 ? 0 : 1;
    const versionNumber = index < 2 ? index + 1 : 1;
    const assets = versionId === source.latestWorldVersionIds[0]
      ? [
          { assetId: source.assetIds[0]!, role: "world_cover" as const },
          { assetId: source.assetIds[1]!, role: "world_version_asset" as const },
        ]
      : [];
    expect(versions.find((entry) => entry.sourceId === versionId)?.record).toEqual({
      sourceId: versionId,
      worldId: source.worldIds[worldIndex],
      versionNumber,
      title: `Release World ${worldIndex + 1}`,
      content: representativeWorldVersionContent(worldIndex, versionNumber, assets),
      contentFingerprint: sha256(`${source.worldIds[worldIndex]}:${versionNumber}`),
      releaseNotes: `Release ${versionNumber}`,
      createdFromRevision: versionNumber,
      publishedAt: representativeTimestamp,
    });
  }
  const drafts = records.filter((entry) => entry.domain === "world-drafts");
  expect(drafts.map((entry) => entry.record)).toEqual(expect.arrayContaining(source.worldIds.map((worldId, index) => (
    {
      sourceId: worldId,
      worldId,
      basedOnWorldVersionId: source.latestWorldVersionIds[index],
      title: `Release World ${index + 1}`,
      revision: 3,
      content: representativeWorldDraftContent(index),
      createdAt: representativeTimestamp,
      updatedAt: representativeTimestamp,
    }
  ))));

  const campaigns = records.filter((entry) => entry.domain === "campaigns");
  expect(campaigns.map((entry) => entry.record)).toEqual(expect.arrayContaining([
    {
      sourceId: source.campaignIds[0],
      worldVersionId: source.latestWorldVersionIds[0],
      title: "Release Campaign 1",
      status: "active",
      activeTurnNumber: 2,
      settings: { turnControlStyle: "Scene Direction" },
      selectedCharacterId: representativeCharacterSnapshot.id,
      characterSnapshot: representativeCharacterSnapshot,
      characterProfile: currentCharacterProfile,
      characterProfileRevision: 2,
      createdAt: representativeTimestamp,
      updatedAt: representativeTimestamp,
    },
    {
      sourceId: source.campaignIds[1],
      worldVersionId: source.latestWorldVersionIds[1],
      title: "Release Campaign 2",
      status: "active",
      activeTurnNumber: 1,
      settings: { turnControlStyle: "Action" },
      selectedCharacterId: null,
      characterSnapshot: null,
      characterProfile: null,
      characterProfileRevision: 0,
      createdAt: representativeTimestamp,
      updatedAt: representativeTimestamp,
    },
  ]));
  const turns = records.filter((entry) => entry.domain === "turns");
  expect(turns.map((entry) => entry.record)).toEqual(expect.arrayContaining([
    {
      sourceId: source.turnIds[0], campaignId: source.campaignIds[0], turnNumber: 1,
      action: "Action 1.1", narration: "Narration 1.1", choices: ["Continue"],
      imagePrompt: "Illustrate 1.1", stateSnapshotPrivate: source.turnSnapshots[0],
      acceptedAt: representativeTimestamp,
    },
    {
      sourceId: source.turnIds[1], campaignId: source.campaignIds[0], turnNumber: 2,
      action: "Action 1.2", narration: "Narration 1.2", choices: ["Continue"],
      imagePrompt: "Illustrate 1.2", stateSnapshotPrivate: source.turnSnapshots[1],
      acceptedAt: representativeTimestamp,
    },
    {
      sourceId: source.turnIds[2], campaignId: source.campaignIds[1], turnNumber: 1,
      action: "Action 2.1", narration: "Narration 2.1", choices: ["Continue"],
      imagePrompt: "Illustrate 2.1", stateSnapshotPrivate: source.turnSnapshots[2],
      acceptedAt: representativeTimestamp,
    },
  ]));
  expect(records.find((entry) => entry.domain === "turn-corrections")?.record).toEqual({
    sourceId: source.correctionId,
    turnId: source.turnIds[0],
    revision: 1,
    narration: "Corrected release narration",
    previousEffectiveNarrationHash: sha256("Narration 1.1"),
    reason: "Release gate correction",
    source: "user_edit",
    correctedAt: representativeTimestamp,
  });

  const states = records.filter((entry) => entry.domain === "campaign-state");
  for (const [index, campaignId] of source.campaignIds.entries()) {
    expect(states.find((entry) => entry.record.campaignId === campaignId)?.record).toEqual({
      sourceId: campaignId,
      campaignId,
      revision: 2,
      state: representativeCampaignState(index, index === 0 ? source.canonicalFactId : undefined),
      updatedAt: representativeTimestamp,
    });
  }

  const history = records.filter((entry) => entry.domain === "campaign-history");
  const acceptedModes = history.filter((entry) => entry.record.eventType === "accepted-turn-mode");
  expect(acceptedModes).toHaveLength(3);
  for (const [index, turnId] of source.turnIds.entries()) {
    const campaignIndex = index < 2 ? 0 : 1;
    const turnNumber = index < 2 ? index + 1 : 1;
    const acceptedMode = acceptedModes.find((entry) => JSON.parse(entry.record.content).turnId === turnId);
    expect(acceptedMode?.record).toEqual({
      sourceId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      campaignId: source.campaignIds[campaignIndex],
      eventType: "accepted-turn-mode",
      content: acceptedMode?.record.content,
      occurredAt: representativeTimestamp,
    });
    expect(JSON.parse(acceptedMode!.record.content)).toEqual({
      turnId,
      turnNumber,
      inputMode: "scene",
      inputModeSource: "auto",
    });
    expect(acceptedMode?.sourceId).toBe(acceptedMode?.record.sourceId);
  }
  const setHistory = history.find((entry) => entry.record.eventType === "illustration-set");
  expect(setHistory?.record).toEqual({
    sourceId: source.illustrationSetId,
    campaignId: source.campaignIds[0],
    eventType: "illustration-set",
    content: setHistory?.record.content,
    occurredAt: representativeTimestamp,
  });
  expect(setHistory?.sourceId).toBe(source.illustrationSetId);
  expect(JSON.parse(setHistory!.record.content)).toEqual({
    turnId: source.turnIds[0],
    segmentWordCount: 100,
    imagesPerSegment: 2,
    promptMode: "direct",
    status: "completed",
    isActive: true,
    characterVisualReference: "",
    completedAt: representativeTimestamp,
  });
  const segmentHistory = history.find((entry) => entry.record.eventType === "illustration-segment");
  expect(segmentHistory?.record).toEqual({
    sourceId: source.illustrationSegmentId,
    campaignId: source.campaignIds[0],
    eventType: "illustration-segment",
    content: segmentHistory?.record.content,
    occurredAt: representativeTimestamp,
  });
  expect(segmentHistory?.sourceId).toBe(source.illustrationSegmentId);
  expect(JSON.parse(segmentHistory!.record.content)).toEqual({
    illustrationSetId: source.illustrationSetId,
    turnId: source.turnIds[0],
    ordinal: 0,
    startOffset: 0,
    endOffset: 13,
    startWord: 0,
    endWord: 2,
    directPrompt: "Release gate",
    resolvedPrompt: "Release gate",
    promptSource: "direct",
    status: "completed",
  });

  expect(records.find((entry) => entry.domain === "canonical-facts")?.record).toEqual({
    sourceId: source.canonicalFactId,
    campaignId: source.campaignIds[0],
    subject: "release gate",
    predicate: "status",
    object: "The release gate is open.",
    sourceTurnId: source.turnIds[0],
    sourceTurnNumber: 1,
    sourceFactIndex: 7,
    validFromTurn: 1,
    validUntilTurn: 3,
    supersededByFactId: null,
    updatedAt: representativeTimestamp,
  });
  const chronicle = records.filter((entry) => entry.domain === "chronicle");
  expect(chronicle.find((entry) => entry.sourceId === source.memoryId)?.record).toEqual({
    sourceId: source.memoryId,
    campaignId: source.campaignIds[0],
    kind: "memory",
    turnId: source.turnIds[0],
    memoryKind: "turn_fiction",
    content: "Release memory",
    occurredAt: representativeTimestamp,
    metadata: { entityNames: ["Gate"], openThreadIds: [] },
  });
  expect(chronicle.find((entry) => entry.sourceId === source.summaryCheckpointId)?.record).toEqual({
    sourceId: source.summaryCheckpointId,
    campaignId: source.campaignIds[0],
    kind: "summary-checkpoint",
    throughTurn: 2,
    summaryKind: "campaign_summary",
    content: "Release summary",
    occurredAt: representativeTimestamp,
    metadata: { entityNames: [], openThreadIds: [source.checkpointOpenThreadId] },
  });

  const illustrations = records.filter((entry) => entry.domain === "illustrations");
  expect(illustrations).toHaveLength(2);
  for (const [variantIndex, assetId] of [source.assetIds[1], source.assetIds[2]].entries()) {
    const illustration = illustrations.find((entry) => entry.record.assetId === assetId);
    expect(illustration?.record).toEqual({
      sourceId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      campaignId: source.campaignIds[0],
      turnId: source.turnIds[0],
      assetId,
      fictionPrompt: "Release gate",
      selected: variantIndex === 0,
      createdAt: representativeTimestamp,
    });
    expect(illustration?.sourceId).toBe(illustration?.record.sourceId);
  }
  expect(records.find((entry) => entry.domain === "imports")?.record).toEqual({
    sourceId: source.importId,
    sourceType: "legacy_story",
    sourceName: "Release source",
    sourceHash: sha256("release-source"),
    campaignId: source.campaignIds[0],
    completedAt: representativeTimestamp,
  });
  const costs = records.filter((entry) => entry.domain === "cost-events");
  expect(costs.map((entry) => entry.record)).toEqual(expect.arrayContaining([
    {
      sourceId: source.costEventIds[0], campaignId: source.campaignIds[0], providerKind: "text",
      amountMicros: 10000, occurredAt: representativeTimestamp,
    },
    {
      sourceId: source.costEventIds[1], campaignId: source.campaignIds[1], providerKind: "image",
      amountMicros: 20000, occurredAt: representativeTimestamp,
    },
  ]));
  expect(records.find((entry) => entry.domain === "activity-events")?.record).toEqual({
    sourceId: source.activitySourceId,
    campaignId: source.campaignIds[0],
    eventType: "campaign.accepted_turn",
    summary: "Release activity",
    occurredAt: representativeTimestamp,
  });

  expect(assetPayload.assets).toHaveLength(source.assets.length);
  for (const expected of source.assets) {
    const asset = assetPayload.assets.find((candidate) => candidate.sourceAssetId === expected.id);
    expect(asset).toEqual({
      sourceAssetId: expected.id,
      contentHash: expected.contentHash,
      archivePath: `assets/sha256/${expected.contentHash.slice(0, 2)}/${expected.contentHash}.png`,
      mimeType: "image/png",
      byteLength: expected.byteLength,
      pixelWidth: expected.pixelWidth,
      pixelHeight: expected.pixelHeight,
      technicalMetadata: {},
      library: {
        title: expected.title,
        caption: "",
        notes: "",
        tags: [],
        origin: "imported",
        reviewStatus: "eligible",
        reuseScope: expected.reuseScope,
        automaticReuseEnabled: false,
        contentCategories: [],
        favorite: expected.favorite,
        archivedAt: expected.archived ? representativeTimestamp : null,
      },
      createdAt: representativeTimestamp,
      bindings: expect.arrayContaining([...expected.bindings]),
    });
    expect(asset?.bindings).toHaveLength(expected.bindings.length);
    const original = asset ? zip.file(asset.archivePath) : null;
    expect(original).not.toBeNull();
    if (original) expect(sha256(await original.async("nodebuffer"))).toBe(expected.contentHash);
  }
}

async function proveResumableUpload(
  runtime: StartedRuntime,
  restart: () => Promise<StartedRuntime>,
  archive: Buffer,
): Promise<StartedRuntime> {
  const upload = await jsonRequest<{ id: string; receivedBytes: number }>(runtime.baseUrl, "/api/v1/system-imports/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ byteLength: archive.byteLength, sha256: sha256(archive) }),
  });
  expectNoSecretSentinels(upload, "resumable-upload creation payload");
  const first = await putUploadChunk(runtime.baseUrl, upload.id, archive, 0, 0);
  expect(first.receivedBytes).toBe(releaseChunkBytes);

  expectNoSecretSentinels(runtime.logs(), "pre-restart resumable-upload runtime logs");
  await runtime.stop();
  const restarted = await restart();
  const recovered = await jsonRequest<{ id: string; status: string; receivedBytes: number }>(
    restarted.baseUrl,
    `/api/v1/system-imports/uploads/${upload.id}`,
  );
  expect(recovered).toMatchObject({ id: upload.id, status: "uploading", receivedBytes: releaseChunkBytes });
  expectNoSecretSentinels(recovered, "recovered resumable-upload progress payload");

  const replayed = await putUploadChunk(restarted.baseUrl, upload.id, archive, 0, 0);
  expect(replayed.receivedBytes).toBe(releaseChunkBytes);
  let chunkIndex = 1;
  for (let offset = releaseChunkBytes; offset < archive.byteLength; offset += releaseChunkBytes) {
    const value = await putUploadChunk(restarted.baseUrl, upload.id, archive, chunkIndex, offset);
    expect(value.receivedBytes).toBe(Math.min(offset + releaseChunkBytes, archive.byteLength));
    chunkIndex += 1;
  }
  const cancelled = await jsonRequest<{ status: string }>(
    restarted.baseUrl,
    `/api/v1/system-imports/uploads/${upload.id}`,
    { method: "DELETE" },
  );
  expect(cancelled.status).toBe("expired");
  expectNoSecretSentinels(cancelled, "cancelled resumable-upload payload");
  expectNoSecretSentinels(restarted.logs(), "post-restart resumable-upload runtime logs");
  return restarted;
}

async function importThroughLegacyUi(
  browser: Browser,
  runtime: StartedRuntime,
  archivePath: string,
  sourceOwnerId: string,
): Promise<Readonly<{
  previewText: string;
  reportText: string;
  preview: SystemImportPreviewView;
  completed: Extract<SystemArchiveJobView, { kind: "import" }>;
}>> {
  const context: BrowserContext = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${runtime.baseUrl}/nexus/index.html#data-transfer`);
    const previewResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/system-imports/preview" && response.request().method() === "POST";
    });
    await page.locator("#systemArchiveFile").setInputFiles(archivePath);
    const previewView = systemImportPreviewViewSchema.parse(await (await previewResponse).json());
    expectNoSecretSentinels(previewView, "import preview API payload");
    expectNoSecretSentinels(previewView.warnings, "import preview warnings");
    expectNoSecretSentinels(previewView.errors, "import preview errors");
    const preview = page.locator('#systemImportPreview[data-system-preview="ready"]');
    await preview.waitFor({ state: "visible", timeout: 120_000 });
    const previewText = await preview.textContent() ?? "";
    expectNoSecretSentinels(previewText, "rendered import preview");
    expect(previewText).toContain(`Source owner ${sourceOwnerId}`);
    expect(previewText).toMatch(/Original images\s*4/u);
    expect(previewText).toContain("Empty and eligible");
    const checkboxes = page.locator('#systemImportAcknowledgements input[type="checkbox"]');
    expect(await checkboxes.count()).toBe(5);
    for (const checkbox of await checkboxes.all()) await checkbox.check();
    const commitResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/v1/system-imports" && response.request().method() === "POST";
    });
    await page.locator("#commitSystemImport").click();
    const accepted = systemArchiveJobViewSchema.parse(await (await commitResponse).json());
    if (accepted.kind !== "import") throw new Error("Legacy UI created a non-import System Archive job.");
    expectNoSecretSentinels(accepted, "accepted import API job payload");
    const report = page.locator('#systemImportReport[data-system-import-state="completed"]');
    await report.waitFor({ state: "visible", timeout: 120_000 });
    const reportText = await report.textContent() ?? "";
    expectNoSecretSentinels(reportText, "rendered completed import report");
    expect(reportText).toContain("Integrity verified");
    expect(reportText).toContain("Fingerprint verified");
    expect(reportText).toContain("Records matched");
    expect(reportText).toContain("Original assets matched");
    expect(reportText).toContain("Chronicle index: queued");
    expect(reportText).toContain("Asset thumbnails: queued");
    const completed = systemArchiveJobViewSchema.parse(
      await jsonRequest(runtime.baseUrl, `/api/v1/system-imports/${accepted.id}`),
    );
    if (completed.kind !== "import") throw new Error("Legacy UI recovered a non-import System Archive job.");
    expect(completed.status).toBe("completed");
    expectNoSecretSentinels(completed, "completed import API job and report");
    expectNoSecretSentinels(completed.report?.warnings, "completed import warnings");
    expectNoSecretSentinels(completed.report?.errors, "completed import errors");
    expectNoSecretSentinels(runtime.logs(), "destination import runtime and worker logs");
    return Object.freeze({ previewText, reportText, preview: previewView, completed });
  } catch (error) {
    throw new Error(`Legacy UI import failed:\n${runtime.logs()}`, { cause: error });
  } finally {
    await context.close();
  }
}

async function assertImportedAuthority(
  destinationUrl: string,
  assetRoot: string,
  source: RepresentativeOwner,
): Promise<void> {
  const pool = createDatabasePool(destinationUrl, 4);
  try {
    const destinationOwnerId = await initialOwnerId(pool);
    expect(destinationOwnerId).not.toBe(source.ownerUserId);
    const sourceOwnerRows = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE id=$1", [source.ownerUserId]);
    expect(sourceOwnerRows.rows[0]!.count).toBe("0");

    const providers = await pool.query<{
      id: string;
      owner_user_id: string;
      name: string;
      provider_type: string;
      provider_role: string;
      base_url: string;
      default_model: string;
      context_window_tokens: number;
      request_timeout_ms: number;
      configuration: Record<string, unknown>;
      enabled: boolean;
      health_status: string;
      encrypted_api_key: string | null;
      credential_nonce: string | null;
      credential_auth_tag: string | null;
    }>(
      `SELECT id,owner_user_id,name,provider_type,provider_role,base_url,default_model,
              context_window_tokens,
              request_timeout_ms,configuration,enabled,health_status,
              encrypted_api_key,credential_nonce,credential_auth_tag
         FROM provider_profiles ORDER BY id`,
    );
    expect(providers.rows).toHaveLength(3);
    for (const expected of source.providers) {
      expect(providers.rows.find((provider) => provider.id === expected.id)).toEqual({
        id: expected.id,
        owner_user_id: destinationOwnerId,
        name: expected.displayName,
        provider_type: "openai_compatible",
        provider_role: expected.kind,
        base_url: expected.baseUrl,
        default_model: expected.selectedModel,
        context_window_tokens: 32768,
        request_timeout_ms: 321000,
        configuration: { retryLimit: 3 },
        enabled: false,
        health_status: "unknown",
        encrypted_api_key: null,
        credential_nonce: null,
        credential_auth_tag: null,
      });
    }
    expectNoSecretSentinels(providers.rows, "destination provider rows");

    const prompts = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string | null;
      prompt_key: string;
      content: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,prompt_key,content,created_at,updated_at
         FROM prompt_template_overrides ORDER BY id`,
    );
    expect(prompts.rows).toHaveLength(3);
    expect(prompts.rows).toEqual(expect.arrayContaining([
      {
        id: source.promptIds[0], owner_user_id: destinationOwnerId, campaign_id: null,
        prompt_key: "story_system", content: "Owner-wide release prompt",
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
      {
        id: source.promptIds[1], owner_user_id: destinationOwnerId, campaign_id: source.campaignIds[0],
        prompt_key: "story_system", content: "Campaign prompt 1",
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
      {
        id: source.promptIds[2], owner_user_id: destinationOwnerId, campaign_id: source.campaignIds[1],
        prompt_key: "story_system", content: "Campaign prompt 2",
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
    ]));
    for (const prompt of prompts.rows) {
      expect(prompt.created_at.toISOString()).toBe(representativeTimestamp);
      expect(prompt.updated_at.toISOString()).toBe(representativeTimestamp);
    }

    const worlds = await pool.query<{
      id: string;
      owner_user_id: string;
      title: string;
      status: string;
      cover_asset_id: string | null;
      forked_from_world_id: string | null;
      forked_from_world_version_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,title,status,cover_asset_id,forked_from_world_id,
              forked_from_world_version_id,created_at,updated_at
         FROM worlds ORDER BY title`,
    );
    expect(worlds.rows).toEqual([
      {
        id: source.worldIds[0], owner_user_id: destinationOwnerId, title: "Release World 1",
        status: "active", cover_asset_id: source.assetIds[0],
        forked_from_world_id: null, forked_from_world_version_id: null,
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
      {
        id: source.worldIds[1], owner_user_id: destinationOwnerId, title: "Release World 2",
        status: "draft", cover_asset_id: null,
        forked_from_world_id: source.worldIds[0],
        forked_from_world_version_id: source.latestWorldVersionIds[0],
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
    ]);
    for (const world of worlds.rows) {
      expect(world.created_at.toISOString()).toBe(representativeTimestamp);
      expect(world.updated_at.toISOString()).toBe(representativeTimestamp);
    }
    const versions = await pool.query<{
      id: string;
      owner_user_id: string;
      world_id: string;
      version_number: number;
      content: ReturnType<typeof worldContentSchema.parse>;
      source_hash: string | null;
      release_notes: string;
      created_from_revision: number | null;
      published_at: Date;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,world_id,version_number,content,source_hash,release_notes,
              created_from_revision,published_at,created_at
         FROM world_versions ORDER BY world_id,version_number`,
    );
    expect(versions.rows.map((row) => row.id).sort()).toEqual([...source.worldVersionIds].sort());
    for (const [index, versionId] of source.worldVersionIds.entries()) {
      const worldIndex = index < 2 ? 0 : 1;
      const versionNumber = index < 2 ? index + 1 : 1;
      const assets = versionId === source.latestWorldVersionIds[0]
        ? [
            { assetId: source.assetIds[0]!, role: "world_cover" as const },
            { assetId: source.assetIds[1]!, role: "world_version_asset" as const },
          ]
        : [];
      const actual = versions.rows.find((row) => row.id === versionId)!;
      expect(actual).toEqual({
        id: versionId,
        owner_user_id: destinationOwnerId,
        world_id: source.worldIds[worldIndex],
        version_number: versionNumber,
        content: representativeWorldVersionContent(worldIndex, versionNumber, assets),
        source_hash: sha256(`${source.worldIds[worldIndex]}:${versionNumber}`),
        release_notes: `Release ${versionNumber}`,
        created_from_revision: versionNumber,
        published_at: expect.any(Date),
        created_at: expect.any(Date),
      });
      expect(actual.published_at.toISOString()).toBe(representativeTimestamp);
      expect(actual.created_at.toISOString()).toBe(representativeTimestamp);
    }

    const drafts = await pool.query<{
      world_id: string;
      owner_user_id: string;
      based_on_world_version_id: string | null;
      revision: number;
      content: ReturnType<typeof worldContentSchema.parse>;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT world_id,owner_user_id,based_on_world_version_id,revision,content,created_at,updated_at
         FROM world_drafts ORDER BY world_id`,
    );
    expect(drafts.rows).toHaveLength(2);
    for (const [index, worldId] of source.worldIds.entries()) {
      const actual = drafts.rows.find((row) => row.world_id === worldId)!;
      expect(actual).toEqual({
        world_id: worldId,
        owner_user_id: destinationOwnerId,
        based_on_world_version_id: source.latestWorldVersionIds[index],
        revision: 3,
        content: representativeWorldDraftContent(index),
        created_at: expect.any(Date),
        updated_at: expect.any(Date),
      });
      expect(actual.created_at.toISOString()).toBe(representativeTimestamp);
      expect(actual.updated_at.toISOString()).toBe(representativeTimestamp);
    }

    const campaigns = await pool.query<{
      id: string;
      owner_user_id: string;
      world_version_id: string;
      title: string;
      status: string;
      active_turn_number: number;
      legacy_settings: Record<string, unknown>;
      turn_control_style: string;
      selected_character_id: string | null;
      character_snapshot: Record<string, unknown> | null;
      character_profile: Record<string, unknown> | null;
      character_profile_revision: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,world_version_id,title,status,active_turn_number,legacy_settings,
              turn_control_style,selected_character_id,character_snapshot,character_profile,
              character_profile_revision,created_at,updated_at
         FROM campaigns ORDER BY title`,
    );
    expect(campaigns.rows).toEqual([
      {
        id: source.campaignIds[0], owner_user_id: destinationOwnerId,
        world_version_id: source.latestWorldVersionIds[0], title: "Release Campaign 1",
        status: "active", active_turn_number: 2,
        legacy_settings: { turnControlStyle: "Scene Direction" },
        turn_control_style: "flexible_scene",
        selected_character_id: representativeCharacterSnapshot.id,
        character_snapshot: representativeCharacterSnapshot,
        character_profile: currentCharacterProfile,
        character_profile_revision: 2,
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
      {
        id: source.campaignIds[1], owner_user_id: destinationOwnerId,
        world_version_id: source.latestWorldVersionIds[1], title: "Release Campaign 2",
        status: "active", active_turn_number: 1,
        legacy_settings: { turnControlStyle: "Action" },
        turn_control_style: "flexible_action",
        selected_character_id: null,
        character_snapshot: null,
        character_profile: null,
        character_profile_revision: 0,
        created_at: expect.any(Date), updated_at: expect.any(Date),
      },
    ]);
    for (const campaign of campaigns.rows) {
      expect(campaign.created_at.toISOString()).toBe(representativeTimestamp);
      expect(campaign.updated_at.toISOString()).toBe(representativeTimestamp);
    }

    const turns = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      turn_number: number;
      action: string;
      narration: string;
      choices: string[];
      image_prompt: string;
      input_mode: string;
      input_mode_source: string;
      state_snapshot_private: Record<string, unknown>;
      accepted_at: Date;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,turn_number,action,narration,choices,image_prompt,
              input_mode,input_mode_source,state_snapshot_private,accepted_at,created_at
         FROM turns ORDER BY campaign_id,turn_number`,
    );
    expect(turns.rows).toHaveLength(3);
    for (const [index, turnId] of source.turnIds.entries()) {
      const campaignIndex = index < 2 ? 0 : 1;
      const turnNumber = index < 2 ? index + 1 : 1;
      expect(turns.rows.find((row) => row.id === turnId)).toEqual({
        id: turnId,
        owner_user_id: destinationOwnerId,
        campaign_id: source.campaignIds[campaignIndex],
        turn_number: turnNumber,
        action: `Action ${campaignIndex + 1}.${turnNumber}`,
        narration: `Narration ${campaignIndex + 1}.${turnNumber}`,
        choices: ["Continue"],
        image_prompt: `Illustrate ${campaignIndex + 1}.${turnNumber}`,
        input_mode: "scene",
        input_mode_source: "auto",
        state_snapshot_private: source.turnSnapshots[index],
        accepted_at: expect.any(Date),
        created_at: expect.any(Date),
      });
      const actual = turns.rows.find((row) => row.id === turnId)!;
      expect(actual.accepted_at.toISOString()).toBe(representativeTimestamp);
      expect(actual.created_at.toISOString()).toBe(representativeTimestamp);
    }
    const correction = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      turn_id: string;
      revision: number;
      narration: string;
      previous_effective_narration_hash: string;
      reason: string | null;
      source: string;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,turn_id,revision,narration,
              previous_effective_narration_hash,reason,source,created_at
         FROM turn_narration_corrections`,
    );
    expect(correction.rows).toEqual([{
      id: source.correctionId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      turn_id: source.turnIds[0],
      revision: 1,
      narration: "Corrected release narration",
      previous_effective_narration_hash: sha256("Narration 1.1"),
      reason: "Release gate correction",
      source: "user_edit",
      created_at: expect.any(Date),
    }]);
    expect(correction.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const states = await pool.query<{
      campaign_id: string;
      owner_user_id: string;
      scratchpad_private: string;
      trackers: Record<string, unknown>[];
      default_triggers: Record<string, unknown>[];
      event_triggers: Record<string, unknown>[];
      pending_event_triggers: Record<string, unknown>[];
      rpg_stats: Record<string, unknown>[];
      revision: number;
      initial_state_snapshot: Record<string, unknown>;
      updated_at: Date;
    }>(
      `SELECT campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
              event_triggers,pending_event_triggers,rpg_stats,revision,initial_state_snapshot,updated_at
         FROM campaign_state ORDER BY campaign_id`,
    );
    expect(states.rows).toHaveLength(2);
    for (const [index, campaignId] of source.campaignIds.entries()) {
      const expectedState = representativeCampaignState(index, index === 0 ? source.canonicalFactId : undefined);
      const actual = states.rows.find((row) => row.campaign_id === campaignId)!;
      expect(actual).toEqual({
        campaign_id: campaignId,
        owner_user_id: destinationOwnerId,
        scratchpad_private: `Continuity ${index + 1}`,
        trackers: representativeTrackers,
        default_triggers: [],
        event_triggers: [],
        pending_event_triggers: [],
        rpg_stats: [],
        revision: 2,
        initial_state_snapshot: expectedState,
        updated_at: expect.any(Date),
      });
      expect(actual.updated_at.toISOString()).toBe(representativeTimestamp);
    }

    const facts = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      world_version_id: string;
      source_turn_id: string | null;
      source_state_edit_id: string | null;
      source_turn_number: number;
      source_fact_index: number;
      content: string;
      metadata: Record<string, unknown>;
      valid_from_turn: number;
      valid_until_turn: number | null;
      superseded_by_fact_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_state_edit_id,
              source_turn_number,source_fact_index,content,metadata,valid_from_turn,
              valid_until_turn,superseded_by_fact_id,created_at,updated_at
         FROM campaign_canonical_facts`,
    );
    expect(facts.rows).toEqual([{
      id: source.canonicalFactId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      world_version_id: source.latestWorldVersionIds[0],
      source_turn_id: source.turnIds[0],
      source_state_edit_id: null,
      source_turn_number: 1,
      source_fact_index: 7,
      content: "The release gate is open.",
      metadata: { subject: "release gate", predicate: "status" },
      valid_from_turn: 1,
      valid_until_turn: 3,
      superseded_by_fact_id: null,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    }]);
    expect(facts.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(facts.rows[0]!.updated_at.toISOString()).toBe(representativeTimestamp);

    const characterProfileEdits = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      revision: number;
      previous_profile: Record<string, unknown> | null;
      next_profile: Record<string, unknown>;
      edit_source: string;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,revision,previous_profile,next_profile,
              edit_source,created_at
         FROM campaign_character_profile_edits`,
    );
    expect(characterProfileEdits.rows).toEqual([{
      id: source.characterProfileEditId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      revision: 2,
      previous_profile: previousCharacterProfile,
      next_profile: currentCharacterProfile,
      edit_source: "manual",
      created_at: expect.any(Date),
    }]);
    expect(characterProfileEdits.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const stateEdits = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      effective_turn_number: number;
      revision: number;
      state_snapshot_private: Record<string, unknown>;
      changed_fields: string[];
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,effective_turn_number,revision,
              state_snapshot_private,changed_fields,created_at
         FROM campaign_state_edits`,
    );
    expect(stateEdits.rows).toEqual([{
      id: source.stateEditId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      effective_turn_number: 2,
      revision: 2,
      state_snapshot_private: representativeCampaignState(0, source.canonicalFactId),
      changed_fields: ["canonicalFacts", "trackers"],
      created_at: expect.any(Date),
    }]);
    expect(stateEdits.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const worldMigrations = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      from_world_version_id: string;
      to_world_version_id: string;
      note: string;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,from_world_version_id,to_world_version_id,
              note,created_at
         FROM campaign_world_migrations`,
    );
    expect(worldMigrations.rows).toEqual([{
      id: source.worldMigrationId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      from_world_version_id: source.worldVersionIds[0],
      to_world_version_id: source.worldVersionIds[1],
      note: "Promote the release campaign to version two.",
      created_at: expect.any(Date),
    }]);
    expect(worldMigrations.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const worldTransfers = await pool.query<{
      id: string;
      owner_user_id: string;
      idempotency_key: string;
      source_campaign_id: string | null;
      target_campaign_id: string | null;
      from_world_version_id: string;
      to_world_version_id: string;
      character_strategy: string;
      state_strategy: string;
      target_defaults_policy: string;
      source_fingerprint: string;
      warnings: string[];
      note: string;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,idempotency_key,source_campaign_id,target_campaign_id,
              from_world_version_id,to_world_version_id,character_strategy,state_strategy,
              target_defaults_policy,source_fingerprint,warnings,note,created_at
         FROM campaign_world_transfers`,
    );
    expect(worldTransfers.rows).toEqual([{
      id: source.worldTransferId,
      owner_user_id: destinationOwnerId,
      idempotency_key: source.worldTransferId,
      source_campaign_id: source.campaignIds[0],
      target_campaign_id: source.campaignIds[1],
      from_world_version_id: source.latestWorldVersionIds[0],
      to_world_version_id: source.latestWorldVersionIds[1],
      character_strategy: "preserve_source",
      state_strategy: "preserve",
      target_defaults_policy: "retain_source",
      source_fingerprint: sha256("release-world-transfer"),
      warnings: ["Release transfer warning"],
      note: "Transfer the release campaign between worlds.",
      created_at: expect.any(Date),
    }]);
    expect(worldTransfers.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const memoryConfigs = await pool.query<{
      campaign_id: string;
      owner_user_id: string;
      embedding_enabled: boolean;
      embedding_provider_profile_id: string | null;
      embedding_model: string;
      embedding_batch_size: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,
              embedding_model,embedding_batch_size,created_at,updated_at
         FROM campaign_memory_configs`,
    );
    expect(memoryConfigs.rows).toEqual([{
      campaign_id: source.campaignIds[0],
      owner_user_id: destinationOwnerId,
      embedding_enabled: true,
      embedding_provider_profile_id: source.providerIds[2],
      embedding_model: "release-embedding",
      embedding_batch_size: 24,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    }]);
    expect(memoryConfigs.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(memoryConfigs.rows[0]!.updated_at.toISOString()).toBe(representativeTimestamp);

    const illustrationConfigs = await pool.query<{
      campaign_id: string;
      owner_user_id: string;
      enabled: boolean;
      provider_profile_id: string | null;
      model: string;
      size: string;
      aspect_ratio: string;
      quality: string;
      output_format: string;
      max_attempts: number;
      source_policy: string;
      matching_scope: string;
      confidence_profile: string;
      repetition_window: number;
      segment_word_count: number;
      images_per_segment: number;
      segment_prompt_mode: string;
      refinement_prompt: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT campaign_id,owner_user_id,enabled,provider_profile_id,model,size,aspect_ratio,
              quality,output_format,max_attempts,source_policy,matching_scope,confidence_profile,
              repetition_window,segment_word_count,images_per_segment,segment_prompt_mode,
              refinement_prompt,created_at,updated_at
         FROM campaign_illustration_configs`,
    );
    expect(illustrationConfigs.rows).toEqual([{
      campaign_id: source.campaignIds[0],
      owner_user_id: destinationOwnerId,
      enabled: true,
      provider_profile_id: source.providerIds[1],
      model: "image-model",
      size: "1536x1024",
      aspect_ratio: "3:2",
      quality: "high",
      output_format: "webp",
      max_attempts: 4,
      source_policy: "library_then_generate",
      matching_scope: "campaign",
      confidence_profile: "strict",
      repetition_window: 9,
      segment_word_count: 250,
      images_per_segment: 2,
      segment_prompt_mode: "ai_refined",
      refinement_prompt: "Preserve the fiction-only release aesthetic.",
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    }]);
    expect(illustrationConfigs.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(illustrationConfigs.rows[0]!.updated_at.toISOString()).toBe(representativeTimestamp);

    const memories = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      world_version_id: string;
      turn_id: string | null;
      memory_kind: string;
      content: string;
      entities: string[];
      metadata: Record<string, unknown>;
      embedding: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,world_version_id,turn_id,memory_kind,content,entities,
              metadata,embedding::text AS embedding,created_at,updated_at FROM chronicle_memories`,
    );
    expect(memories.rows).toEqual([{
      id: source.memoryId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      world_version_id: source.latestWorldVersionIds[0],
      turn_id: source.turnIds[0],
      memory_kind: "turn_fiction",
      content: "Release memory",
      entities: ["Gate"],
      metadata: { openThreadIds: [] },
      embedding: null,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    }]);
    expect(memories.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(memories.rows[0]!.updated_at.toISOString()).toBe(representativeTimestamp);
    const checkpoints = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      through_turn: number;
      summary_kind: string;
      content: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,through_turn,summary_kind,content,created_at
         FROM summary_checkpoints`,
    );
    expect(checkpoints.rows).toEqual([{
      id: source.summaryCheckpointId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      through_turn: 2,
      summary_kind: "campaign_summary",
      content: { summary: "Release summary", entityNames: [], openThreadIds: [source.checkpointOpenThreadId] },
      created_at: expect.any(Date),
    }]);
    expect(checkpoints.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const provenance = await pool.query<{
      id: string;
      owner_user_id: string;
      source_type: string;
      source_name: string;
      source_hash: string;
      status: string;
      campaign_id: string | null;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id,owner_user_id,source_type,source_name,source_hash,status,campaign_id,
              created_at,completed_at
         FROM imports WHERE id=$1`,
      [source.importId],
    );
    expect(provenance.rows).toEqual([{
      id: source.importId,
      owner_user_id: destinationOwnerId,
      source_type: "legacy_story",
      source_name: "Release source",
      source_hash: sha256("release-source"),
      status: "completed",
      campaign_id: source.campaignIds[0],
      created_at: expect.any(Date),
      completed_at: expect.any(Date),
    }]);
    expect(provenance.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(provenance.rows[0]!.completed_at?.toISOString()).toBe(representativeTimestamp);

    const costs = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      turn_id: string | null;
      provider_profile_id: string | null;
      provider_type: string;
      category: string;
      operation: string;
      amount_micros: number;
      currency: string;
      usage_metadata: Record<string, unknown>;
      occurred_at: Date;
      created_at: Date;
    }>(
      `SELECT id,owner_user_id,campaign_id,turn_id,provider_profile_id,provider_type,
              category,operation,round(amount*1000000)::int AS amount_micros,currency,
              usage_metadata,occurred_at,created_at
         FROM provider_cost_events ORDER BY id`,
    );
    expect(costs.rows).toHaveLength(2);
    for (const [index, id] of source.costEventIds.entries()) {
      const kind = index === 0 ? "text" : "image";
      expect(costs.rows.find((row) => row.id === id)).toEqual({
        id,
        owner_user_id: destinationOwnerId,
        campaign_id: source.campaignIds[index],
        turn_id: null,
        provider_profile_id: null,
        provider_type: "system_archive",
        category: index === 0 ? "story" : "image",
        operation: "restored",
        amount_micros: index === 0 ? 10000 : 20000,
        currency: "USD",
        usage_metadata: { providerKind: kind },
        occurred_at: expect.any(Date),
        created_at: expect.any(Date),
      });
      const actual = costs.rows.find((row) => row.id === id)!;
      expect(actual.occurred_at.toISOString()).toBe(representativeTimestamp);
      expect(actual.created_at.toISOString()).toBe(representativeTimestamp);
    }

    const activity = await pool.query<{
      owner_user_id: string;
      campaign_id: string | null;
      event_type: string;
      correlation_id: string | null;
      details: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT owner_user_id,campaign_id,event_type,correlation_id,details,created_at
         FROM activity_events WHERE correlation_id=$1`,
      [source.activitySourceId],
    );
    expect(activity.rows).toEqual([{
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      event_type: "campaign.accepted_turn",
      correlation_id: source.activitySourceId,
      details: { summary: "Release activity", sourceId: source.activitySourceId },
      created_at: expect.any(Date),
    }]);
    expect(activity.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);

    const illustrationSets = await pool.query<{
      id: string;
      owner_user_id: string;
      campaign_id: string;
      turn_id: string;
      source_text_hash: string;
      segment_word_count: number;
      images_per_segment: number;
      prompt_mode: string;
      status: string;
      is_active: boolean;
      character_visual_reference: string;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id,owner_user_id,campaign_id,turn_id,source_text_hash,segment_word_count,
              images_per_segment,prompt_mode,status,is_active,character_visual_reference,
              created_at,completed_at FROM turn_illustration_sets`,
    );
    expect(illustrationSets.rows).toEqual([{
      id: source.illustrationSetId,
      owner_user_id: destinationOwnerId,
      campaign_id: source.campaignIds[0],
      turn_id: source.turnIds[0],
      source_text_hash: sha256("Narration 1.1"),
      segment_word_count: 100,
      images_per_segment: 2,
      prompt_mode: "direct",
      status: "completed",
      is_active: true,
      character_visual_reference: "",
      created_at: expect.any(Date),
      completed_at: expect.any(Date),
    }]);
    expect(illustrationSets.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(illustrationSets.rows[0]!.completed_at?.toISOString()).toBe(representativeTimestamp);
    const illustrationSegments = await pool.query<{
      id: string;
      owner_user_id: string;
      illustration_set_id: string;
      campaign_id: string;
      turn_id: string;
      ordinal: number;
      start_offset: number;
      end_offset: number;
      start_word: number;
      end_word: number;
      source_text: string;
      source_text_hash: string;
      direct_prompt: string;
      resolved_prompt: string;
      prompt_source: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id,owner_user_id,illustration_set_id,campaign_id,turn_id,ordinal,start_offset,
              end_offset,start_word,end_word,source_text,source_text_hash,direct_prompt,
              resolved_prompt,prompt_source,status,created_at,updated_at
         FROM turn_illustration_segments`,
    );
    expect(illustrationSegments.rows).toEqual([{
      id: source.illustrationSegmentId,
      owner_user_id: destinationOwnerId,
      illustration_set_id: source.illustrationSetId,
      campaign_id: source.campaignIds[0],
      turn_id: source.turnIds[0],
      ordinal: 0,
      start_offset: 0,
      end_offset: 13,
      start_word: 0,
      end_word: 2,
      source_text: "Narration 1.1",
      source_text_hash: sha256("Narration 1.1"),
      direct_prompt: "Release gate",
      resolved_prompt: "Release gate",
      prompt_source: "direct",
      status: "completed",
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    }]);
    expect(illustrationSegments.rows[0]!.created_at.toISOString()).toBe(representativeTimestamp);
    expect(illustrationSegments.rows[0]!.updated_at.toISOString()).toBe(representativeTimestamp);
    const segmentAssets = await pool.query<{
      segment_id: string;
      owner_user_id: string;
      asset_id: string;
      variant_index: number;
      created_at: Date;
    }>(
      `SELECT segment_id,owner_user_id,asset_id,variant_index,created_at
         FROM turn_illustration_segment_assets ORDER BY variant_index`,
    );
    expect(segmentAssets.rows).toEqual([
      {
        segment_id: source.illustrationSegmentId, owner_user_id: destinationOwnerId,
        asset_id: source.assetIds[1], variant_index: 0, created_at: expect.any(Date),
      },
      {
        segment_id: source.illustrationSegmentId, owner_user_id: destinationOwnerId,
        asset_id: source.assetIds[2], variant_index: 1, created_at: expect.any(Date),
      },
    ]);
    for (const asset of segmentAssets.rows) {
      expect(asset.created_at.toISOString()).toBe(representativeTimestamp);
    }

    const assets = await pool.query<{
      id: string;
      owner_user_id: string;
      content_hash: string;
      storage_path: string;
      mime_type: string;
      byte_length: number;
      pixel_width: number;
      pixel_height: number;
      technical_metadata: Record<string, unknown>;
      title: string;
      caption: string;
      notes: string;
      tags: string[];
      origin: string;
      review_status: string;
      reuse_scope: string;
      automatic_reuse_enabled: boolean;
      content_categories: string[];
      favorite: boolean;
      archived_at: Date | null;
      created_at: Date;
    }>(
      `SELECT asset.id,asset.owner_user_id,asset.content_hash,asset.storage_path,asset.mime_type,
              asset.byte_length::int AS byte_length,asset.pixel_width,asset.pixel_height,
              asset.technical_metadata,library.title,library.caption,library.notes,library.tags,
              library.origin,library.review_status,library.reuse_scope,
              library.automatic_reuse_enabled,library.content_categories,library.favorite,
              library.archived_at,asset.created_at
         FROM assets asset
         JOIN asset_library_entries library
           ON library.asset_id=asset.id AND library.owner_user_id=asset.owner_user_id
        ORDER BY asset.id`,
    );
    expect(assets.rows).toHaveLength(4);
    expect(assets.rows.map((row) => row.id).sort()).toEqual([...source.assetIds].sort());
    for (const asset of assets.rows) {
      const bytes = await readFile(join(assetRoot, asset.storage_path));
      expect(sha256(bytes)).toBe(asset.content_hash);
      const expected = source.assets.find((candidate) => candidate.id === asset.id)!;
      expect(asset).toEqual({
        id: expected.id,
        owner_user_id: destinationOwnerId,
        content_hash: expected.contentHash,
        storage_path: asset.storage_path,
        mime_type: "image/png",
        byte_length: expected.byteLength,
        pixel_width: expected.pixelWidth,
        pixel_height: expected.pixelHeight,
        technical_metadata: {},
        title: expected.title,
        caption: "",
        notes: "",
        tags: [],
        origin: "imported",
        review_status: "eligible",
        reuse_scope: expected.reuseScope,
        automatic_reuse_enabled: false,
        content_categories: [],
        favorite: expected.favorite,
        archived_at: expected.archived ? expect.any(Date) : null,
        created_at: expect.any(Date),
      });
      expect(asset.created_at.toISOString()).toBe(representativeTimestamp);
      if (asset.archived_at) expect(asset.archived_at.toISOString()).toBe(representativeTimestamp);
    }

    for (const table of ["generation_jobs", "model_chains", "chronicle_memory_chunks", "world_share_links"] as const) {
      const excluded = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(excluded.rows[0]!.count).toBe("0");
    }
    for (const table of [
      "generation_jobs", "model_chains", "chronicle_memory_chunks", "chronicle_jobs", "world_share_links",
    ] as const) {
      const contents = await pool.query<{ serialized: string }>(
        `SELECT COALESCE(string_agg(to_jsonb(row_value)::text,E'\\n'),'') AS serialized
           FROM ${table} row_value`,
      );
      expectNoSecretSentinels(contents.rows[0]!.serialized, `destination ${table}`);
    }
    const embeddings = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE embedding IS NOT NULL",
    );
    expect(embeddings.rows[0]!.count).toBe("0");

    const imported = await pool.query<{
      status: string;
      progress: Record<string, unknown>;
      report: Record<string, unknown>;
    }>(
      "SELECT status,progress,report FROM system_archive_jobs WHERE kind='import' ORDER BY created_at DESC LIMIT 1",
    );
    expect(imported.rows[0]?.status).toBe("completed");
    expectNoSecretSentinels(imported.rows[0], "durable import database progress and report");
    const durableReport = imported.rows[0]?.report as undefined | { warnings?: unknown; errors?: unknown };
    expectNoSecretSentinels(durableReport?.warnings, "durable import warnings");
    expectNoSecretSentinels(durableReport?.errors, "durable import errors");
    expect(imported.rows[0]?.report).toMatchObject({
      sourceOwnerCount: 1,
      ownerMapping: { sourceOwnerId: source.ownerUserId, destinationOwnerId },
      disabledProviders: 3,
      assetCount: 4,
      recordsByDomain: source.expectedDomainCounts,
      integrityReconciliation: {
        archiveFingerprintVerified: true,
        recordsMatched: true,
        assetsMatched: true,
      },
      rebuildState: {
        chronicleIndex: { status: "queued", itemCount: 2 },
        assetThumbnails: { status: "queued", itemCount: 4 },
      },
    });
  } finally {
    await pool.end();
  }
}

describe("System Archive v1 release compatibility", () => {
  it("pins and inspects the frozen minimal fixture without regenerating its exact payload bytes", async () => {
    const { manifestBytes, systemBytes, assetsBytes, archiveBytes } = await frozenFixture();

    expect(sha256(manifestBytes)).toBe("71bc16ab105ec19027a83c3efa2853f3f96f55987f5f14720f3a53838106c8b8");
    expect(sha256(systemBytes)).toBe("1638f356315d4e8bed22b7e53bce6393c4dd9a172a2bc4f9d1d11e9dc11db09e");
    expect(sha256(assetsBytes)).toBe("7232be54c721cfe125ea7c5f42487f964cb24d38d9f816a6888bb703aacd9f1f");

    const manifest = systemArchiveManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    const payload = systemArchivePayloadSchema.parse(JSON.parse(systemBytes.toString("utf8")));
    expect(manifest.entries).toEqual([
      {
        path: "assets/assets.json",
        logicalType: "assets",
        mediaType: "application/json",
        byteLength: 32,
        sha256: "7232be54c721cfe125ea7c5f42487f964cb24d38d9f816a6888bb703aacd9f1f",
      },
      {
        path: "system.json",
        logicalType: "system",
        mediaType: "application/json",
        byteLength: 212,
        sha256: "1638f356315d4e8bed22b7e53bce6393c4dd9a172a2bc4f9d1d11e9dc11db09e",
      },
    ]);
    expect(manifest.contentFingerprint).toBe("821bb722b661d59eda2511fbe4663b69ebcd49fa1f782cbdf884455be884b852");
    expect(payload).toMatchObject({
      formatVersion: 1,
      sourceOwnerCount: 1,
      sourceOwner: {
        sourceId: "22222222-2222-4222-8222-222222222222",
        displayName: "Fixture Owner",
      },
      records: [],
    });

    const archiveRoot = await mkdtemp(join(tmpdir(), "iq-system-v1-fixture-"));
    try {
      const staged = await stageArchiveUpload(Readable.from(archiveBytes), archiveRoot, fixtureLimits);
      const inspection = await inspectSystemArchiveForPreview(staged, fixtureLimits);
      expect(inspection).toMatchObject({
        formatVersion: 1,
        sourceOwnerId: "22222222-2222-4222-8222-222222222222",
        sourceOwnerCount: 1,
        recordsByDomain: expect.objectContaining({ worlds: 0, campaigns: 0, turns: 0 }),
        assetCount: 0,
      });
    } finally {
      await rm(archiveRoot, { recursive: true, force: true });
    }
  });

  releaseGate(
    "imports the frozen minimal fixture through the compiled service into isolated PostgreSQL and private roots (Linux only)",
    async () => {
      await buildReleaseArtifacts();
      const fixture = await frozenFixture();
      const privateRoot = await mkdtemp(join(tmpdir(), "iq-system-v1-import-"));
      const archiveRoot = join(privateRoot, "archives");
      const assetRoot = join(privateRoot, "assets");
      await Promise.all([
        mkdir(archiveRoot, { recursive: true }),
        mkdir(assetRoot, { recursive: true }),
      ]);
      const admin = createDatabasePool(databaseUrl!, 2);
      let destination: Awaited<ReturnType<typeof createDestinationDatabase>> | undefined;
      let runtime: StartedRuntime | undefined;
      try {
        destination = await createDestinationDatabase(admin, databaseUrl!);
        runtime = await startCompiledRuntime({
          databaseUrl: destination.url,
          archiveRoot,
          assetRoot,
          port: await freePort(),
          role: "all",
        });
        const imported = await importArchiveThroughApi(runtime, fixture.archiveBytes);
        expect(imported.report).toMatchObject({
          sourceOwnerCount: 1,
          assetCount: 0,
          integrityReconciliation: {
            archiveFingerprintVerified: true,
            recordsMatched: true,
            assetsMatched: true,
          },
        });
        const pool = createDatabasePool(destination.url, 2);
        try {
          const destinationOwnerId = await initialOwnerId(pool);
          expect(destinationOwnerId).not.toBe("22222222-2222-4222-8222-222222222222");
          await expect(pool.query<{ users: string; worlds: string; assets: string }>(
            `SELECT (SELECT count(*)::text FROM users) AS users,
                    (SELECT count(*)::text FROM worlds) AS worlds,
                    (SELECT count(*)::text FROM assets) AS assets`,
          )).resolves.toMatchObject({ rows: [{ users: "1", worlds: "0", assets: "0" }] });
        } finally {
          await pool.end();
        }
      } finally {
        await runtime?.stop().catch(() => undefined);
        if (destination) await dropDestinationDatabase(admin, destination.name);
        await admin.end();
        await rm(privateRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );

  releaseGate(
    "round-trips representative authority through the compiled service, isolated PostgreSQL, private roots, and both built clients (Linux only)",
    async () => {
      await buildReleaseArtifacts();
      const sourceRoot = await mkdtemp(join(tmpdir(), "iq-system-release-source-"));
      const destinationRoot = await mkdtemp(join(tmpdir(), "iq-system-release-destination-"));
      const sourceArchiveRoot = join(sourceRoot, "archives");
      const sourceAssetRoot = join(sourceRoot, "assets");
      const destinationArchiveRoot = join(destinationRoot, "archives");
      const destinationAssetRoot = join(destinationRoot, "assets");
      const downloadPath = join(sourceRoot, "owner-system.zip");
      await Promise.all([
        mkdir(sourceArchiveRoot, { recursive: true }),
        mkdir(sourceAssetRoot, { recursive: true }),
        mkdir(destinationArchiveRoot, { recursive: true }),
        mkdir(destinationAssetRoot, { recursive: true }),
      ]);

      const admin = createDatabasePool(databaseUrl!, 2);
      let source: Awaited<ReturnType<typeof createDestinationDatabase>> | undefined;
      let destination: Awaited<ReturnType<typeof createDestinationDatabase>> | undefined;
      let sourceRuntime: StartedRuntime | undefined;
      let destinationRuntime: StartedRuntime | undefined;
      let browser: Browser | undefined;
      try {
        source = await createDestinationDatabase(admin, databaseUrl!);
        destination = await createDestinationDatabase(admin, databaseUrl!);
        const sourcePool = createDatabasePool(source.url, 4);
        let representative: RepresentativeOwner;
        try {
          representative = await seedRepresentativeOwner(sourcePool, sourceAssetRoot);
        } finally {
          await sourcePool.end();
        }

        browser = await chromium.launch({ headless: true });
        const sourcePort = await freePort();
        sourceRuntime = await startCompiledRuntime({
          databaseUrl: source.url,
          archiveRoot: sourceArchiveRoot,
          assetRoot: sourceAssetRoot,
          port: sourcePort,
          role: "api",
        });
        const published = await exportThroughReplacementUi(
          browser,
          sourceRuntime,
          source.url,
          sourceArchiveRoot,
          sourceAssetRoot,
          downloadPath,
        );
        const archive = await readFile(downloadPath);
        expect(archive.byteLength).toBeGreaterThan(releaseChunkBytes);
        expect(archive.subarray(0, 2).toString("ascii")).toBe("PK");
        expect(representative.canonicalFactId).toMatch(/^[a-f0-9-]{36}$/u);
        expect(representative.summaryCheckpointId).toMatch(/^[a-f0-9-]{36}$/u);
        expect(representative.expectedDomainCounts.chronicle).toBe(2);
        await assertRepresentativeArchive(archive, published, representative);
        await sourceRuntime.stop();
        sourceRuntime = undefined;

        const destinationPort = await freePort();
        destinationRuntime = await startCompiledRuntime({
          databaseUrl: destination.url,
          archiveRoot: destinationArchiveRoot,
          assetRoot: destinationAssetRoot,
          port: destinationPort,
          role: "api",
        });
        destinationRuntime = await proveResumableUpload(
          destinationRuntime,
          () => startCompiledRuntime({
            databaseUrl: destination!.url,
            archiveRoot: destinationArchiveRoot,
            assetRoot: destinationAssetRoot,
            port: destinationPort,
            role: "api",
          }),
          archive,
        );
        await destinationRuntime.stop();
        destinationRuntime = await startCompiledRuntime({
          databaseUrl: destination.url,
          archiveRoot: destinationArchiveRoot,
          assetRoot: destinationAssetRoot,
          port: destinationPort,
          role: "all",
        });
        const imported = await importThroughLegacyUi(
          browser,
          destinationRuntime,
          downloadPath,
          representative.ownerUserId,
        );
        expect(imported.reportText).toMatch(/Original images\s*4/u);
        expect(imported.preview.recordsByDomain).toEqual(representative.expectedDomainCounts);
        expect(imported.preview.assets).toEqual({
          originalCount: published.report?.assetCount,
          totalBytes: published.report?.assetBytes,
        });
        expect(imported.preview.archiveFingerprint).toBe(published.report?.archiveFingerprint);
        expect(imported.preview.disabledProviders).toBe(3);
        expect(imported.completed.report).not.toBeNull();
        expect(imported.completed.report?.recordsByDomain).toEqual(representative.expectedDomainCounts);
        expect(imported.completed.report?.recordsByDomain).toEqual(imported.preview.recordsByDomain);
        expect(imported.completed.report?.assetCount).toBe(imported.preview.assets.originalCount);
        expect(imported.completed.report?.assetBytes).toBe(imported.preview.assets.totalBytes);
        expect(imported.completed.report?.archiveFingerprint).toBe(imported.preview.archiveFingerprint);
        expect(imported.completed.report?.operationalOmissions).toEqual(imported.preview.operationalOmissions);
        await assertImportedAuthority(destination.url, destinationAssetRoot, representative);

        const playable = await fetch(`${destinationRuntime.baseUrl}/api/v1/campaigns/${representative.campaignIds[0]}/turns?limit=1`);
        expect(playable.status).toBe(200);
        expectNoSecretSentinels(destinationRuntime.logs(), "completed destination runtime and worker logs");
      } finally {
        await browser?.close().catch(() => undefined);
        await destinationRuntime?.stop().catch(() => undefined);
        await sourceRuntime?.stop().catch(() => undefined);
        if (destination) await dropDestinationDatabase(admin, destination.name);
        if (source) await dropDestinationDatabase(admin, source.name);
        await admin.end();
        await Promise.all([
          rm(sourceRoot, { recursive: true, force: true }),
          rm(destinationRoot, { recursive: true, force: true }),
        ]);
      }
    },
    360_000,
  );
});
