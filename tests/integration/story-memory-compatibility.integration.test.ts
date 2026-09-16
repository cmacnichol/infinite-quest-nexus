import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { buildCampaignArchiveArtifact } from "../../services/runtime/src/campaign-archive-export-composition.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { inspectArchive, readVerifiedEntry, stageArchiveUpload, type ArchiveLimits } from "../../services/api/src/archive-io.js";
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationRequestSchema } from "../../packages/contracts/src/generation.js";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { SYSTEM_ARCHIVE_DOMAINS, type SystemRecordEnvelope } from "../../packages/contracts/src/system-archives.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresSystemArchiveExportRepository } from "../../packages/database/src/system-archive-export-repository.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";
import { saveStoryMemoryEnrollment } from "../../packages/database/src/story-memory-policy-repository.js";
import { createApiGenerationApplication as composeGeneration } from "../../services/runtime/src/generation-api-composition.js";
import { createProvider } from "../helpers/provider-application-fixtures.js";
import { apiProviderGraph } from "../helpers/provider-application-fixtures.js";
import { importLegacyStory } from "../helpers/memory-aware-services.js";
import { runGenerationJob } from "../helpers/generation-worker-harness.js";
import { installIntegrationProviderTransport } from "./provider-transport-test-helper.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
const credentialSecret = "t19-story-memory-compatibility-secret";

function nextTurn(supersedesFactId?: string): string {
  return JSON.stringify({
    narration: "The tidekeeper opens the corrected harbor gate.",
    choices: ["Enter the harbor.", "Question the keeper.", "Study the gate.", "Wait by the quay."],
    custom_action_suggestion: "Ask the tidekeeper about the gate.",
    scratchpad: "Private next-turn note.",
    tracker_updates: [],
    image_prompt: "A tidekeeper opening a moonlit harbor gate.",
    continuity_summary: "The corrected harbor gate is open.",
    canonical_facts: ["The corrected harbor gate is open."],
    superseded_facts: [],
    canonical_fact_updates: supersedesFactId ? [{ content: "The tidekeeper grants the party permission to reopen the harbor gate.", supersedes_fact_ids: [supersedesFactId] }] : [],
    open_threads: ["Learn why the tidekeeper guarded the gate."]
  });
}

async function exportRecords(pool: DatabasePool, ownerUserId: string): Promise<SystemRecordEnvelope[]> {
  const exporter = createPostgresSystemArchiveExportRepository(pool, { pageSize: 25, sourceApplicationVersion: "t19" });
  return exporter.withOwnerSnapshot({ ownerUserId }, async (snapshot) => {
    const records: SystemRecordEnvelope[] = [];
    for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
      for await (const record of snapshot.streamDomain(domain)) records.push(record);
    }
    return records;
  });
}

integration("T19 story-memory archive compatibility", () => {
  let pool: DatabasePool;
  let server: Server;
  let providerId = "";
  let ownerUserId = "";
  const providerBodies: string[] = [];

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 6);
    await migrateDatabase(pool, resolve("database/migrations"));
    const transport = installIntegrationProviderTransport();
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
        providerBodies.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: randomUUID(), model: "t19-capturing-provider",
          choices: [{ message: { content: nextTurn((JSON.parse(JSON.parse(body).messages?.[1]?.content ?? "{}").authoritative_context?.currentContinuity?.canonicalFacts ?? []).find((fact: { id: string | null; content: string }) => fact.content.includes("CANONICAL_FACT_SENTINEL"))?.id) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 }
        }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("T19 capturing provider did not bind.");
    (server as Server & { transport?: { close(): Promise<void> } }).transport = transport;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    await (server as Server & { transport?: { close(): Promise<void> } }).transport?.close();
    await pool?.end();
  });

  it.each(["system", "campaign_zip"] as const)("restores %s into an empty destination and regenerates from corrected authority without operational state", async (kind) => {
    await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    await pool.query("INSERT INTO users(system_key,display_name,status) VALUES ('initial-owner','Initial Owner','active')");
    await pool.end();
    pool = createDatabasePool(databaseUrl!, 6);
    ownerUserId = await initialOwnerId(pool);
    const legacy = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
    legacy.world.title = `T19 harbor ${randomUUID()}`;
    const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({ sourceName: "t19.story", story: legacy }));
    const sourceCampaign = await pool.query<{ world_version_id: string; id: string; selected_character_id: string | null }>(
      "SELECT id,world_version_id,selected_character_id FROM campaigns WHERE id=$1", [imported.campaignId]
    );
    const source = sourceCampaign.rows[0]!;
    const correctedNarration = "CORRECTED_NARRATION_SENTINEL: the harbor gate was reopened by the tidekeeper.";
    const canonicalFact = "CANONICAL_FACT_SENTINEL: only the tidekeeper may reopen the harbor gate.";
    const profileMarker = "CAMPAIGN_PROFILE_SENTINEL: remembers every tide oath.";
    await pool.query(
      `UPDATE campaigns SET character_profile=$2::jsonb,character_profile_revision=1
        WHERE id=$1`,
      [source.id, JSON.stringify({ name: "Campaign Keeper", profile: { story: { otherGuidance: profileMarker } } })]
    );
    const latest = await pool.query<{ id: string; turn_number: number; narration: string }>(
      "SELECT id,turn_number,narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [source.id]
    );
    await pool.query(
      `INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,reason,source,created_by_user_id)
       VALUES ($1,$2,$3,1,$4,$5,'t19 compatibility','user_edit',$1)`,
      [ownerUserId, source.id, latest.rows[0]!.id, correctedNarration,
        createHash("sha256").update(latest.rows[0]!.narration).digest("hex")]
    );
    const sourceFactId = randomUUID();
    const unmappedSourceFactId = randomUUID();
    await pool.query(
      `INSERT INTO campaign_canonical_facts(
         id,owner_user_id,campaign_id,world_version_id,source_turn_id,source_turn_number,source_fact_index,
         content,normalized_content,entities,entity_ids,valid_from_turn,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,lower($7),ARRAY[]::text[],ARRAY[]::text[],$6,'{}'::jsonb)`,
      [sourceFactId, ownerUserId, source.id, source.world_version_id, latest.rows[0]!.id, latest.rows[0]!.turn_number, canonicalFact]
    );
    // Match a real accepted fact: ZIP rebuilds the derived fact table from the
    // authoritative accepted snapshot, rather than exporting an orphan index row.
    await pool.query("UPDATE turns SET state_snapshot_private=state_snapshot_private || $2::jsonb WHERE id=$1",
      [latest.rows[0]!.id, JSON.stringify({ canonicalFacts: [{ id: sourceFactId, content: canonicalFact }], canonicalFactUpdates: [{ content: "The quay bell is bronze.", supersedesFactIds: [unmappedSourceFactId] }] })]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Capturing provider lost its address.");
    providerId = (await createProvider(pool, {
      name: `T19 source provider ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "t19-capturing-provider",
      contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret)).id;
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: source.id },
      { capability: "r1", reviewMode: "off" }, { installedCapability: "r1", enforceEnabled: false });
    const sourceApplication = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined,
      { installedCapability: "r1", enforceEnabled: false });
    const privateJob = await sourceApplication.enqueueAppend({ ownerUserId, campaignId: source.id }, generationRequestSchema.parse({
      action: "PRIVATE_JOB_ACTION_CANARY", providerProfileId: providerId, idempotencyKey: randomUUID(),
      context: { budgetTokens: 60_000, compression: "full", recentTurns: 8 }
    }));
    await pool.query(`UPDATE generation_jobs SET orchestration_private=$2::jsonb,partial_output=$3,streaming_segments_state=$4::jsonb WHERE id=$1`,
      [privateJob.id, JSON.stringify({ privateCanary: "PRIVATE_REVIEW_CHECKPOINT_CANARY" }), "PRIVATE_PROVISIONAL_NARRATION_CANARY",
        JSON.stringify({ privateCanary: "PRIVATE_STREAM_CHECKPOINT_CANARY" })]);
    const records = await exportRecords(pool, ownerUserId);
    const root = await mkdtemp(join(tmpdir(), "iq-continuity-archive-"));
    const limits: ArchiveLimits = { maxCompressedBytes: 10_000_000, maxUncompressedBytes: 50_000_000,
      maxEntries: 1000, maxManifestBytes: 1_000_000, maxJsonEntryBytes: 5_000_000, maxExpansionRatio: 100, maxOriginalImageBytes: 25_000_000 };
    const artifact = await buildCampaignArchiveArtifact(pool, { async readOriginal() { throw new Error("No assets expected"); } },
      { ownerUserId, campaignId: source.id, archiveRoot: root, limits });
    const zipBytes = await readFile(artifact.absolutePath);
    const inspection = await inspectArchive(await stageArchiveUpload(Readable.from(zipBytes), root, limits), limits, "campaign");
    const campaignJson = (await readVerifiedEntry(inspection, "campaign.json", limits.maxJsonEntryBytes)).toString("utf8");
    for (const archiveBytes of [JSON.stringify(records), campaignJson]) {
      for (const marker of ["PRIVATE_JOB_ACTION_CANARY", "PRIVATE_REVIEW_CHECKPOINT_CANARY", "PRIVATE_PROVISIONAL_NARRATION_CANARY", "PRIVATE_STREAM_CHECKPOINT_CANARY"])
        expect(archiveBytes).not.toContain(marker);
    }

    // This test file owns an isolated database. Clearing the source creates the
    // destination that a real System Archive restore requires.
    await pool.query("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
    await pool.query("INSERT INTO users(system_key,display_name,status) VALUES ('initial-owner','Initial Owner','active')");
    // initialOwnerId caches by pool; reopening models a distinct destination process.
    await pool.end();
    pool = createDatabasePool(databaseUrl!, 6);
    ownerUserId = await initialOwnerId(pool);
    if (kind === "system") {
      const importer = createPostgresSystemArchiveImportRepository(pool);
      const destination = await importer.destinationFingerprint({ ownerUserId }, {});
      expect(destination.destinationEmpty).toBe(true);
      await importer.withAtomicImport({ ownerUserId }, { destination, ignore: {} }, async (transaction) => {
        await transaction.insertLogicalDomains(records);
      });
    } else {
      expect((await pool.query("SELECT id FROM campaigns")).rows).toEqual([]);
      await Promise.all([mkdir(join(root, "imports")), mkdir(join(root, "assets"))]);
      const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
      const composition = await createPortableImportExportComposition({
        pool, worlds: adapters.worlds, roots: { archiveRoot: join(root, "imports"), assetRoot: join(root, "assets") }, leaseOwner: "t19-zip",
        provider: { async convertTemplate() { throw new Error("No provider expected"); } },
        targets: { async readTargetWorldVersion() { throw new Error("Embedded target only"); } },
        exports: { async buildCampaignArchive() { throw new Error("No export expected"); }, async buildWorldJson() { throw new Error("No export expected"); } }
      });
      try {
        const staged = await composition.stageInput({ owner: { ownerUserId }, operationScopeId: randomUUID(), leaseOwner: "t19-stage",
          expiresAt: new Date(Date.now() + 3600000).toISOString(), byteLength: zipBytes.byteLength, source: [zipBytes] });
        const preview = await composition.previewCampaignZip({ ownerUserId, stagedInput: staged.stagedInput, kind: "campaign_zip", destination: { kind: "embedded", operation: "create_world" } });
        await composition.commit({ ownerUserId, kind: "campaign_zip", destination: preview.destination, previewHandle: preview.previewHandle, idempotencyKey: randomUUID() });
      } finally { await composition.close(); }
    }
    await rm(root, { recursive: true, force: true });
    expect((await pool.query("SELECT id FROM generation_jobs")).rows).toEqual([]);
    if (kind === "campaign_zip") {
      const snapshots = await pool.query("SELECT state_snapshot_private FROM turns");
      expect(JSON.stringify(snapshots.rows)).not.toContain(unmappedSourceFactId);
    }
    const restored = await pool.query<{ id: string; world_version_id: string; selected_character_id: string | null; character_profile: unknown }>(
      "SELECT id,world_version_id,selected_character_id,character_profile FROM campaigns WHERE owner_user_id=$1", [ownerUserId]
    );
    expect(restored.rows).toHaveLength(1);
    // System Archive is a whole-installation restore and retains authoritative
    // UUIDs; Campaign ZIP portability owns the separate remapping proof.
    if (kind === "system") {
      expect(restored.rows[0]!.id).toBe(source.id);
      expect(restored.rows[0]!.selected_character_id).toBe(source.selected_character_id);
    } else {
      expect(restored.rows[0]!.id).not.toBe(source.id);
      expect(restored.rows[0]!.world_version_id).not.toBe(source.world_version_id);
    }
    expect(JSON.stringify(restored.rows[0]!.character_profile)).toContain(profileMarker);
    // Operational source enrollment is excluded; the destination applies its Max default.
    await expect(pool.query("SELECT campaign_id,capability,review_mode FROM campaign_story_memory_enrollments WHERE owner_user_id=$1", [ownerUserId]))
      .resolves.toMatchObject({ rows: [{ campaign_id: restored.rows[0]!.id, capability: "r3", review_mode: "enforce" }] });


    providerId = (await createProvider(pool, {
      name: `T19 provider ${randomUUID()}`, providerType: "openai_compatible", providerRole: "text",
      baseUrl: `http://127.0.0.1:${address.port}`, defaultModel: "t19-capturing-provider",
      contextWindowTokens: 65_536, maxOutputTokens: 4_096, temperature: 0, enabled: true, configuration: {}
    }, credentialSecret)).id;
    await saveStoryMemoryEnrollment(pool, { ownerUserId, campaignId: restored.rows[0]!.id },
      { capability: "r1", reviewMode: "off" }, { installedCapability: "r1", enforceEnabled: false });
    const application = composeGeneration(pool, apiProviderGraph(pool, credentialSecret).generation, undefined,
      { installedCapability: "r1", enforceEnabled: false });
    const job = await application.enqueueAppend({ ownerUserId, campaignId: restored.rows[0]!.id }, generationRequestSchema.parse({
      action: "Ask the tidekeeper to reopen the harbor gate.", providerProfileId: providerId, idempotencyKey: randomUUID(),
      context: { budgetTokens: 60_000, compression: "full", recentTurns: 8 }
    }));
    expect(await runGenerationJob(pool, `t19-worker-${randomUUID()}`, 30, credentialSecret)).toBe(true);
    const completed = await application.getJob({ ownerUserId, jobId: job.id });
    expect({ status: completed.status, errorCode: completed.errorCode, errorMessage: completed.errorMessage }).toMatchObject({ status: "completed", errorCode: null });
    const request = providerBodies.at(-1);
    expect(request).toContain(correctedNarration);
    expect(request).toContain(canonicalFact);
    const wire = JSON.parse(JSON.parse(request!).messages[1].content);
    const destinationFact = (await pool.query<{ id: string; source_turn_id: string }>(
      "SELECT id,source_turn_id FROM campaign_canonical_facts WHERE campaign_id=$1 AND content=$2", [restored.rows[0]!.id, canonicalFact])).rows[0]!;
    expect(destinationFact).toBeDefined();
    const visibleFacts = wire.authoritative_context.currentContinuity.canonicalFacts;
    expect(visibleFacts).toContainEqual({ id: destinationFact.id, content: canonicalFact });
    if (kind === "system") expect(destinationFact.id).toBe(sourceFactId);
    else {
      expect(destinationFact.id).not.toBe(sourceFactId);
      expect(destinationFact.source_turn_id).not.toBe(latest.rows[0]!.id);
      expect(request).not.toContain(sourceFactId);
    }
    const superseded = await pool.query<{ valid_until_turn: number; superseded_by_fact_id: string }>(
      "SELECT valid_until_turn,superseded_by_fact_id FROM campaign_canonical_facts WHERE id=$1 AND campaign_id=$2", [destinationFact.id, restored.rows[0]!.id]);
    expect(superseded.rows[0]!.valid_until_turn).toBe(latest.rows[0]!.turn_number + 1);
    expect(superseded.rows[0]!.superseded_by_fact_id).toEqual(expect.any(String));
    expect(request).toContain(profileMarker);
    await expect(pool.query<{ narration: string }>("SELECT narration FROM turns WHERE campaign_id=$1 ORDER BY turn_number DESC LIMIT 1", [restored.rows[0]!.id]))
      .resolves.toMatchObject({ rows: [{ narration: "The tidekeeper opens the corrected harbor gate." }] });
  });
});
