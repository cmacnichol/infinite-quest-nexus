import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import {
  systemArchiveManifestSchema,
  systemArchivePayloadSchema,
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
const releaseGate = databaseUrl && supportsSecureGeneratedArchiveStaging() ? it : it.skip;
const releaseChunkBytes = 1024 * 1024;

type StartedRuntime = Readonly<{
  baseUrl: string;
  logs(): string;
  stop(): Promise<void>;
}>;

type RepresentativeOwner = Readonly<{
  ownerUserId: string;
  worldIds: readonly string[];
  worldVersionIds: readonly string[];
  campaignIds: readonly string[];
  turnIds: readonly string[];
  providerIds: readonly string[];
  originalHashes: readonly string[];
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
    env: {
      ...process.env,
      APP_ROLE: input.role,
      APP_HOST: "127.0.0.1",
      APP_PORT: String(input.port),
      DATABASE_URL: input.databaseUrl,
      DATABASE_MAX_CONNECTIONS: "12",
      MIGRATION_DIRECTORY: resolve("database/migrations"),
      WORKER_POLL_INTERVAL_MS: "250",
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
      LOG_LEVEL: "warn",
      NEXUS_VERSION: "0.1.0",
    },
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

async function putUploadChunk(
  baseUrl: string,
  uploadId: string,
  archive: Buffer,
  index: number,
  offset: number,
): Promise<{ id: string; status: string; byteLength: number; receivedBytes: number }> {
  const bytes = archive.subarray(offset, Math.min(offset + releaseChunkBytes, archive.byteLength));
  return jsonRequest(baseUrl, `/api/v1/system-imports/uploads/${uploadId}/chunks/${index}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-range": `bytes ${offset}-${offset + bytes.byteLength - 1}/${archive.byteLength}`,
      "x-chunk-sha256": sha256(bytes),
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
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
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = await jsonRequest<{ id: string; status: string; report: Record<string, unknown> | null }>(
      runtime.baseUrl,
      `/api/v1/system-imports/${accepted.id}`,
    );
    if (job.status === "completed") return job;
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
  for (const [displayName, role, baseUrl] of [
    ["Release text", "text", "https://fixture-user:fixture-password@text.invalid/v1?api_key=hidden"],
    ["Release image", "image", "https://image.invalid/v1"],
    ["Release embedding", "embedding", "https://embedding.invalid/v1"],
  ] as const) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles (
         owner_user_id,name,provider_type,provider_role,base_url,default_model,
         request_timeout_ms,configuration,encrypted_api_key,credential_nonce,
         credential_auth_tag,credential_key_version,enabled,health_status
       ) VALUES ($1,$2,'openai_compatible',$3,$4,$5,321000,$6::jsonb,
                 'encrypted-secret','nonce','tag',1,true,'healthy') RETURNING id`,
      [ownerUserId, displayName, role, baseUrl, `${role}-model`, JSON.stringify({ retryLimit: 3, password: "excluded" })],
    );
    providerIds.push(inserted.rows[0]!.id);
  }
  await pool.query(
    "INSERT INTO prompt_template_overrides (owner_user_id,prompt_key,content) VALUES ($1,'story_system','Owner-wide release prompt')",
    [ownerUserId],
  );

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
      const content = worldContentSchema.parse({
        world: {
          title,
          genre: "Archive fantasy",
          tone: "Exact",
          premise: `Portable world ${worldIndex + 1}, version ${versionNumber}.`,
          firstAction: "Begin the release gate.",
        },
      });
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
    const draftContent = worldContentSchema.parse({
      world: {
        title,
        genre: "Archive fantasy",
        tone: "Draft",
        premise: `Editable draft ${worldIndex + 1}.`,
        firstAction: "Revise.",
      },
    });
    await pool.query(
      `INSERT INTO world_drafts (world_id,owner_user_id,based_on_world_version_id,revision,content)
       VALUES ($1,$2,$3,3,$4::jsonb)`,
      [worldId, ownerUserId, latestVersionId, JSON.stringify(draftContent)],
    );
  }

  const campaignIds: string[] = [];
  const turnIds: string[] = [];
  for (const [campaignIndex, worldId] of worldIds.entries()) {
    const campaign = await pool.query<{ id: string }>(
      `INSERT INTO campaigns (
         owner_user_id,world_version_id,title,active_turn_number,turn_control_style
       ) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        ownerUserId,
        latestVersionByWorld.get(worldId),
        `Release Campaign ${campaignIndex + 1}`,
        campaignIndex === 0 ? 2 : 1,
        campaignIndex === 0 ? "flexible_scene" : "flexible_action",
      ],
    );
    const campaignId = campaign.rows[0]!.id;
    campaignIds.push(campaignId);
    await pool.query(
      `INSERT INTO campaign_state (
         campaign_id,owner_user_id,scratchpad_private,trackers,default_triggers,
         event_triggers,pending_event_triggers,rpg_stats,revision
       ) VALUES ($1,$2,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,2)`,
      [campaignId, ownerUserId, `Continuity ${campaignIndex + 1}`, JSON.stringify([{ id: "gate", name: "Gate", value: "open", rules: "Preserve" }])],
    );
    await pool.query(
      `INSERT INTO prompt_template_overrides (owner_user_id,campaign_id,prompt_key,content)
       VALUES ($1,$2,'story_system',$3)`,
      [ownerUserId, campaignId, `Campaign prompt ${campaignIndex + 1}`],
    );
    const turnCount = campaignIndex === 0 ? 2 : 1;
    for (let turnNumber = 1; turnNumber <= turnCount; turnNumber += 1) {
      const turn = await pool.query<{ id: string }>(
        `INSERT INTO turns (
           owner_user_id,campaign_id,turn_number,action,narration,choices,image_prompt,
           input_mode,input_mode_source,state_snapshot_private,accepted_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'scene','auto',$8::jsonb,
                   '2026-08-25T12:00:00.000Z') RETURNING id`,
        [
          ownerUserId,
          campaignId,
          turnNumber,
          `Action ${campaignIndex + 1}.${turnNumber}`,
          `Narration ${campaignIndex + 1}.${turnNumber}`,
          JSON.stringify(["Continue"]),
          `Illustrate ${campaignIndex + 1}.${turnNumber}`,
          JSON.stringify({
            continuitySummary: `Continuity ${campaignIndex + 1}`,
            openThreads: [`Thread ${campaignIndex + 1}`],
            scratchpad: `Continuity ${campaignIndex + 1}`,
            trackers: [],
            rpgStats: [],
            eventTriggers: [],
            pendingEventTriggers: [],
          }),
        ],
      );
      turnIds.push(turn.rows[0]!.id);
    }
  }

  await pool.query(
    `INSERT INTO turn_narration_corrections (
       owner_user_id,campaign_id,turn_id,revision,narration,
       previous_effective_narration_hash,reason,source,created_by_user_id
     ) VALUES ($1,$2,$3,1,'Corrected release narration',$4,
               'Release gate correction','user_edit',$1)`,
    [ownerUserId, campaignIds[0], turnIds[0], sha256("Narration 1.1")],
  );
  await pool.query(
    `INSERT INTO campaign_canonical_facts (
       id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,
       source_fact_index,content,normalized_content,valid_from_turn
     ) VALUES ($1,$2,$3,$4,$5,1,0,'The release gate is open.','the release gate is open',1)`,
    [randomUUID(), ownerUserId, campaignIds[0], latestVersionByWorld.get(worldIds[0]!), turnIds[0]],
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
  await pool.query(
    `INSERT INTO summary_checkpoints (
       owner_user_id,campaign_id,through_turn,summary_kind,content,token_estimate
     ) VALUES ($1,$2,2,'campaign_summary',$3::jsonb,4)`,
    [ownerUserId, campaignIds[0], JSON.stringify({ summary: "Release summary", openThreadIds: [randomUUID()] })],
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
  await pool.query(
    `INSERT INTO imports (owner_user_id,source_type,source_name,source_hash,status,campaign_id,completed_at)
     VALUES ($1,'legacy_story','Release source',$2,'completed',$3,now())`,
    [ownerUserId, sha256("release-source"), campaignIds[0]],
  );
  for (const [index, category] of ["story", "image"].entries()) {
    await pool.query(
      `INSERT INTO provider_cost_events (
         owner_user_id,campaign_id,turn_id,provider_profile_id,provider_type,category,
         operation,amount,currency
       ) VALUES ($1,$2,$3,$4,'openai_compatible',$5,'response',$6,'USD')`,
      [
        ownerUserId,
        campaignIds[index]!,
        turnIds[index === 0 ? 0 : 2]!,
        providerIds[index]!,
        category,
        index === 0 ? 0.01 : 0.02,
      ],
    );
  }
  await pool.query(
    `INSERT INTO activity_events (owner_user_id,campaign_id,event_type,details)
     VALUES ($1,$2,'campaign.accepted_turn',$3::jsonb)`,
    [ownerUserId, campaignIds[0], JSON.stringify({ summary: "Release activity" })],
  );

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
  const largeRaw = randomBytes(800 * 800 * 4);
  const originals = await Promise.all([
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#ff0000" } }).png().toBuffer(),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#00ff00" } }).png().toBuffer(),
    sharp({ create: { width: 4, height: 4, channels: 4, background: "#0000ff" } }).png().toBuffer(),
    sharp(largeRaw, { raw: { width: 800, height: 800, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer(),
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

  return Object.freeze({
    ownerUserId,
    worldIds: Object.freeze(worldIds),
    worldVersionIds: Object.freeze(worldVersionIds),
    campaignIds: Object.freeze(campaignIds),
    turnIds: Object.freeze(turnIds),
    providerIds: Object.freeze(providerIds),
    originalHashes: Object.freeze(originalHashes),
  });
}

async function exportThroughReplacementUi(
  browser: Browser,
  runtime: StartedRuntime,
  restart: () => Promise<StartedRuntime>,
  downloadPath: string,
): Promise<StartedRuntime> {
  const cancellationContext = await browser.newContext({ acceptDownloads: true });
  try {
    const cancellationPage = await cancellationContext.newPage();
    await cancellationPage.goto(`${runtime.baseUrl}/app/data-transfer`);
    const createExport = cancellationPage.locator('[data-action="create-system-export"]');
    await createExport.waitFor({ state: "visible" });
    await createExport.click();
    const cancel = cancellationPage.locator('[data-action="cancel-system-operation"]');
    await cancel.waitFor({ state: "visible" });
    await cancel.click();
    await cancellationPage.getByText("System Export: cancelled.", { exact: true }).waitFor();
  } finally {
    await cancellationContext.close();
  }

  const durableContext = await browser.newContext({ acceptDownloads: true });
  const page = await durableContext.newPage();
  await page.goto(`${runtime.baseUrl}/app/data-transfer`);
  await page.locator('[data-action="create-system-export"]').click();
  await page.locator('[data-action="cancel-system-operation"]').waitFor({ state: "visible" });
  await runtime.stop();
  const restarted = await restart();
  try {
    await page.reload();
    const downloadLink = page.locator("[data-system-download]");
    await downloadLink.waitFor({ state: "visible", timeout: 120_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    await downloadLink.click();
    const download = await downloadPromise;
    await download.saveAs(downloadPath);
  } catch (error) {
    throw new Error(`Replacement UI export failed:\n${restarted.logs()}`, { cause: error });
  } finally {
    await durableContext.close();
  }
  return restarted;
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
  const first = await putUploadChunk(runtime.baseUrl, upload.id, archive, 0, 0);
  expect(first.receivedBytes).toBe(releaseChunkBytes);

  await runtime.stop();
  const restarted = await restart();
  const recovered = await jsonRequest<{ id: string; status: string; receivedBytes: number }>(
    restarted.baseUrl,
    `/api/v1/system-imports/uploads/${upload.id}`,
  );
  expect(recovered).toMatchObject({ id: upload.id, status: "uploading", receivedBytes: releaseChunkBytes });

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
  return restarted;
}

async function importThroughLegacyUi(
  browser: Browser,
  runtime: StartedRuntime,
  archivePath: string,
  sourceOwnerId: string,
): Promise<string> {
  const context: BrowserContext = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${runtime.baseUrl}/nexus/index.html#data-transfer`);
    await page.locator("#systemArchiveFile").setInputFiles(archivePath);
    const preview = page.locator('#systemImportPreview[data-system-preview="ready"]');
    await preview.waitFor({ state: "visible", timeout: 120_000 });
    const previewText = await preview.textContent();
    expect(previewText).toContain(`Source owner ${sourceOwnerId}`);
    expect(previewText).toMatch(/Original images\s*4/u);
    expect(previewText).toContain("Empty and eligible");
    const checkboxes = page.locator('#systemImportAcknowledgements input[type="checkbox"]');
    expect(await checkboxes.count()).toBe(5);
    for (const checkbox of await checkboxes.all()) await checkbox.check();
    await page.locator("#commitSystemImport").click();
    const report = page.locator('#systemImportReport[data-system-import-state="completed"]');
    await report.waitFor({ state: "visible", timeout: 120_000 });
    const reportText = await report.textContent() ?? "";
    expect(reportText).toContain("Integrity verified");
    expect(reportText).toContain("Fingerprint verified");
    expect(reportText).toContain("Records matched");
    expect(reportText).toContain("Original assets matched");
    expect(reportText).toContain("Chronicle index: queued");
    expect(reportText).toContain("Asset thumbnails: queued");
    return reportText;
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

    for (const [table, ids] of [
      ["worlds", source.worldIds],
      ["world_versions", source.worldVersionIds],
      ["campaigns", source.campaignIds],
      ["turns", source.turnIds],
      ["provider_profiles", source.providerIds],
    ] as const) {
      const restored = await pool.query<{ id: string; owner_user_id: string }>(
        `SELECT id,owner_user_id FROM ${table} WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [ids],
      );
      expect(restored.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
      expect(new Set(restored.rows.map((row) => row.owner_user_id))).toEqual(new Set([destinationOwnerId]));
    }
    const drafts = await pool.query<{ world_id: string; owner_user_id: string }>(
      "SELECT world_id,owner_user_id FROM world_drafts ORDER BY world_id",
    );
    expect(drafts.rows.map((row) => row.world_id).sort()).toEqual([...source.worldIds].sort());
    expect(new Set(drafts.rows.map((row) => row.owner_user_id))).toEqual(new Set([destinationOwnerId]));

    const providers = await pool.query<{
      id: string;
      enabled: boolean;
      health_status: string;
      encrypted_api_key: string | null;
      credential_nonce: string | null;
      credential_auth_tag: string | null;
    }>("SELECT id,enabled,health_status,encrypted_api_key,credential_nonce,credential_auth_tag FROM provider_profiles ORDER BY id");
    expect(providers.rows).toHaveLength(3);
    for (const provider of providers.rows) {
      expect(provider).toMatchObject({
        enabled: false,
        health_status: "unknown",
        encrypted_api_key: null,
        credential_nonce: null,
        credential_auth_tag: null,
      });
    }
    const campaigns = await pool.query<{ id: string; active_turn_number: number; turn_control_style: string }>(
      "SELECT id,active_turn_number,turn_control_style FROM campaigns ORDER BY title",
    );
    expect(campaigns.rows).toEqual([
      expect.objectContaining({ active_turn_number: 2, turn_control_style: "flexible_scene" }),
      expect.objectContaining({ active_turn_number: 1, turn_control_style: "flexible_action" }),
    ]);
    const correction = await pool.query<{ narration: string }>("SELECT narration FROM turn_narration_corrections");
    expect(correction.rows).toEqual([{ narration: "Corrected release narration" }]);
    const state = await pool.query<{ scratchpad_private: string }>("SELECT scratchpad_private FROM campaign_state ORDER BY scratchpad_private");
    expect(state.rows.map((row) => row.scratchpad_private)).toEqual(["Continuity 1", "Continuity 2"]);
    const prompts = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM prompt_template_overrides");
    expect(prompts.rows[0]!.count).toBe("3");

    const assets = await pool.query<{ content_hash: string; storage_path: string }>(
      "SELECT content_hash,storage_path FROM assets ORDER BY content_hash",
    );
    expect(assets.rows.map((row) => row.content_hash).sort()).toEqual([...source.originalHashes].sort());
    for (const asset of assets.rows) {
      const bytes = await readFile(join(assetRoot, asset.storage_path));
      expect(sha256(bytes)).toBe(asset.content_hash);
    }
    const archived = await pool.query<{ title: string; reuse_scope: string; archived_at: Date | null }>(
      "SELECT title,reuse_scope,archived_at FROM asset_library_entries WHERE title='unbound-archived'",
    );
    expect(archived.rows).toEqual([
      expect.objectContaining({ title: "unbound-archived", reuse_scope: "owner_library", archived_at: expect.any(Date) }),
    ]);

    for (const table of ["generation_jobs", "model_chains", "chronicle_memory_chunks", "world_share_links"] as const) {
      const excluded = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(excluded.rows[0]!.count).toBe("0");
    }
    const embeddings = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chronicle_memories WHERE embedding IS NOT NULL",
    );
    expect(embeddings.rows[0]!.count).toBe("0");

    const imported = await pool.query<{ status: string; report: Record<string, unknown> }>(
      "SELECT status,report FROM system_archive_jobs WHERE kind='import' ORDER BY created_at DESC LIMIT 1",
    );
    expect(imported.rows[0]?.status).toBe("completed");
    expect(imported.rows[0]?.report).toMatchObject({
      sourceOwnerCount: 1,
      ownerMapping: { sourceOwnerId: source.ownerUserId, destinationOwnerId },
      disabledProviders: 3,
      assetCount: 4,
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
      let destination: Awaited<ReturnType<typeof createDestinationDatabase>> | undefined;
      let sourceRuntime: StartedRuntime | undefined;
      let destinationRuntime: StartedRuntime | undefined;
      let browser: Browser | undefined;
      try {
        destination = await createDestinationDatabase(admin, databaseUrl!);
        const sourcePool = createDatabasePool(databaseUrl!, 4);
        let representative: RepresentativeOwner;
        try {
          representative = await seedRepresentativeOwner(sourcePool, sourceAssetRoot);
        } finally {
          await sourcePool.end();
        }

        browser = await chromium.launch({ headless: true });
        const sourcePort = await freePort();
        sourceRuntime = await startCompiledRuntime({
          databaseUrl: databaseUrl!,
          archiveRoot: sourceArchiveRoot,
          assetRoot: sourceAssetRoot,
          port: sourcePort,
          role: "api",
        });
        sourceRuntime = await exportThroughReplacementUi(
          browser,
          sourceRuntime,
          () => startCompiledRuntime({
            databaseUrl: databaseUrl!,
            archiveRoot: sourceArchiveRoot,
            assetRoot: sourceAssetRoot,
            port: sourcePort,
            role: "all",
          }),
          downloadPath,
        );
        const archive = await readFile(downloadPath);
        expect(archive.byteLength).toBeGreaterThan(releaseChunkBytes);
        expect(archive.subarray(0, 2).toString("ascii")).toBe("PK");
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
        const reportText = await importThroughLegacyUi(
          browser,
          destinationRuntime,
          downloadPath,
          representative.ownerUserId,
        );
        expect(reportText).toMatch(/Original images\s*4/u);
        await assertImportedAuthority(destination.url, destinationAssetRoot, representative);

        const playable = await fetch(`${destinationRuntime.baseUrl}/api/v1/campaigns/${representative.campaignIds[0]}/turns?limit=1`);
        expect(playable.status).toBe(200);
      } finally {
        await browser?.close().catch(() => undefined);
        await destinationRuntime?.stop().catch(() => undefined);
        await sourceRuntime?.stop().catch(() => undefined);
        if (destination) await dropDestinationDatabase(admin, destination.name);
        await admin.end();
        await Promise.all([
          rm(sourceRoot, { recursive: true, force: true }),
          rm(destinationRoot, { recursive: true, force: true }),
        ]);
      }
    },
    240_000,
  );
});
