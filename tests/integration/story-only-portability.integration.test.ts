import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { describe, expect, it } from "vitest";
import { canonicalArchiveJson } from "../../packages/contracts/src/archives.js";
import { calculateContentFingerprint } from "../../packages/contracts/src/archives-node.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { buildCampaignArchiveArtifact } from "../../services/runtime/src/campaign-archive-export-composition.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";
import { inspectArchive, readVerifiedEntry, stageArchiveUpload, type ArchiveLimits } from "../../services/api/src/archive-io.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const limits: ArchiveLimits = {
  maxCompressedBytes: 10_000_000,
  maxUncompressedBytes: 50_000_000,
  maxEntries: 1_000,
  maxManifestBytes: 1_000_000,
  maxJsonEntryBytes: 5_000_000,
  maxExpansionRatio: 100,
  maxOriginalImageBytes: 25_000_000,
};

async function rewriteCampaignPayload(
  root: string,
  inspected: Awaited<ReturnType<typeof inspectArchive>>,
  mutate: (campaign: Record<string, unknown>) => void,
): Promise<Buffer> {
  const bytes = new Map<string, Buffer>();
  for (const entry of inspected.manifest.entries) {
    bytes.set(entry.path, await readVerifiedEntry(inspected, entry.path,
      entry.mediaType === "application/json" ? limits.maxJsonEntryBytes : limits.maxOriginalImageBytes));
  }
  const campaign = JSON.parse(bytes.get("campaign.json")!.toString("utf8")) as Record<string, unknown>;
  mutate(campaign);
  const campaignBytes = Buffer.from(canonicalArchiveJson(campaign), "utf8");
  bytes.set("campaign.json", campaignBytes);
  const entries = inspected.manifest.entries.map((entry) => entry.path === "campaign.json"
    ? { ...entry, byteLength: campaignBytes.byteLength, sha256: createHash("sha256").update(campaignBytes).digest("hex") }
    : entry);
  const manifest = {
    ...inspected.manifest,
    entries,
    contentFingerprint: calculateContentFingerprint({
      payloadHashes: entries.filter((entry) => entry.mediaType === "application/json").map((entry) => entry.sha256),
      originalAssetHashes: inspected.manifest.assets.map((asset) => asset.contentHash),
    }),
  };
  const archivePath = join(root, `tampered-policy-${randomUUID()}.zip`);
  const output = createWriteStream(archivePath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const closed = once(output, "close");
  archive.pipe(output);
  for (const entry of entries) archive.append(bytes.get(entry.path)!, { name: entry.path });
  archive.append(Buffer.from(canonicalArchiveJson(manifest), "utf8"), { name: "manifest.json" });
  await archive.finalize();
  await closed;
  try {
    return await readFile(archivePath);
  } finally {
    await unlink(archivePath);
  }
}

integration("story-only campaign ZIP portability", () => {
  it("round-trips story-only policy provenance and dormant campaign state through actual ZIP ingress", async () => {
    const pool = createDatabasePool(databaseUrl!, 4);
    const root = await mkdtemp(join(tmpdir(), "iq-story-only-portability-"));
    let composition: Awaited<ReturnType<typeof createPortableImportExportComposition>> | undefined;
    try {
      await migrateDatabase(pool, resolve("database/migrations"));
      const sourceOwner = await initialOwnerId(pool);
      const destinationOwner = (await pool.query<{ id: string }>(
        "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id", [`ZIP destination ${randomUUID()}`]
      )).rows[0]!.id;
      const world = (await pool.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id,title) VALUES ($1,'ZIP policy world') RETURNING id", [sourceOwner]
      )).rows[0]!;
      const version = (await pool.query<{ id: string }>(
        "INSERT INTO world_versions (world_id,owner_user_id,version_number,content) VALUES ($1,$2,1,$3::jsonb) RETURNING id",
        [world.id, sourceOwner, JSON.stringify({ schemaVersion: 4, world: { title: "ZIP policy world" } })]
      )).rows[0]!;
      const campaign = (await pool.query<{ id: string }>(
        `INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number,turn_control_style)
         VALUES ($1,$2,'ZIP story-only campaign',1,'flexible_scene') RETURNING id`, [sourceOwner, version.id]
      )).rows[0]!;
      await pool.query(
        `INSERT INTO campaign_state (campaign_id,owner_user_id,rpg_stats,pending_event_triggers)
         VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
        [campaign.id, sourceOwner, JSON.stringify([{ name: "Dormant stat", value: 7 }]), JSON.stringify([{ event: "dormant" }])]
      );
      const runtimePolicy = {
        version: 1,
        playMode: "story_only",
        turnControlStyle: "flexible_scene",
        protocolVersion: "story-only-v1",
        prompts: {
          systemSupplement: "private prompt text",
          systemSupplementHash: "a".repeat(64),
          choiceRepairSystem: "private repair text",
          choiceRepairSystemHash: "b".repeat(64),
        },
      };
      await pool.query(
        `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,generation_policy,accepted_at)
         VALUES ($1,$2,1,'Open the gate.','The gate opens.',$3::jsonb,now())`,
        [sourceOwner, campaign.id, JSON.stringify(runtimePolicy)]
      );
      const artifact = await buildCampaignArchiveArtifact(pool, { async readOriginal() { throw new Error("No assets expected"); } }, {
        ownerUserId: sourceOwner, campaignId: campaign.id, archiveRoot: root, limits,
      });
      const stagedArtifact = await stageArchiveUpload(Readable.from(await readFile(artifact.absolutePath)), root, limits);
      const inspected = await inspectArchive(stagedArtifact, limits, "campaign");
      expect(inspected.manifest.formatVersion).toBe(2);
      const exportedCampaign = JSON.parse((await readVerifiedEntry(inspected, "campaign.json", limits.maxJsonEntryBytes)).toString("utf8"));
      expect(exportedCampaign).toMatchObject({ formatVersion: 4, generationPolicyVersion: 1, settings: { turnControlStyle: "flexible_scene" } });
      expect(exportedCampaign.turns[0].portableAcceptedGenerationPolicyProvenance).toEqual({
        version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
      });
      expect(JSON.stringify(exportedCampaign)).not.toContain("private prompt text");

      await Promise.all([mkdir(join(root, "imports")), mkdir(join(root, "assets"))]);
      const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
      composition = await createPortableImportExportComposition({
        pool, worlds: adapters.worlds, roots: { archiveRoot: join(root, "imports"), assetRoot: join(root, "assets") },
        leaseOwner: "story-only-zip-portability",
        provider: { async convertTemplate() { throw new Error("ZIP import must not call a provider"); } },
        targets: { async readTargetWorldVersion() { throw new Error("Embedded import has no destination target"); } },
        exports: {
          async buildCampaignArchive() { throw new Error("This test directly invokes the production ZIP builder"); },
          async buildWorldJson() { throw new Error("World export not expected"); },
        },
      });
      const malformedBytes = await rewriteCampaignPayload(root, inspected, (campaignPayload) => {
        const turn = (campaignPayload.turns as Array<Record<string, unknown>>)[0]!;
        turn.portableAcceptedGenerationPolicyProvenance = {
          version: 2, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
        };
      });
      const countBeforeRejectedPreview = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM campaigns");
      const malformedStaged = await composition.stageInput({
        owner: { ownerUserId: destinationOwner }, operationScopeId: `story-only-malformed-${randomUUID()}`,
        leaseOwner: "story-only-malformed-stage", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        byteLength: malformedBytes.byteLength, source: [malformedBytes],
      });
      await expect(composition.previewCampaignZip({
        ownerUserId: destinationOwner, stagedInput: malformedStaged.stagedInput, kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" },
      })).rejects.toThrow();
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM campaigns")).resolves.toMatchObject({
        rows: [{ count: countBeforeRejectedPreview.rows[0]!.count }],
      });
      const mismatchedPayloadBytes = await rewriteCampaignPayload(root, inspected, (campaignPayload) => {
        campaignPayload.formatVersion = 3;
      });
      const mismatchedStaged = await composition.stageInput({
        owner: { ownerUserId: destinationOwner }, operationScopeId: `story-only-version-mismatch-${randomUUID()}`,
        leaseOwner: "story-only-version-mismatch-stage", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        byteLength: mismatchedPayloadBytes.byteLength, source: [mismatchedPayloadBytes],
      });
      await expect(composition.previewCampaignZip({
        ownerUserId: destinationOwner, stagedInput: mismatchedStaged.stagedInput, kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" },
      })).rejects.toThrow();
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM campaigns")).resolves.toMatchObject({
        rows: [{ count: countBeforeRejectedPreview.rows[0]!.count }],
      });
      const bytes = await readFile(artifact.absolutePath);
      const staged = await composition.stageInput({
        owner: { ownerUserId: destinationOwner }, operationScopeId: `story-only-zip-${randomUUID()}`,
        leaseOwner: "story-only-zip-stage", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), byteLength: bytes.byteLength, source: [bytes],
      });
      const preview = await composition.previewCampaignZip({
        ownerUserId: destinationOwner, stagedInput: staged.stagedInput, kind: "campaign_zip", destination: { kind: "embedded", operation: "create_world" },
      });
      const committed = await composition.commit({
        ownerUserId: destinationOwner, kind: "campaign_zip", destination: preview.destination,
        previewHandle: preview.previewHandle, idempotencyKey: `story-only-zip-import-${randomUUID()}`,
      });
      if (committed.kind !== "campaign_zip" || !("campaignId" in committed.result)) throw new Error("Campaign ZIP commit was incomplete");
      const importedCampaignId = committed.result.campaignId;
      const imported = await pool.query<{ owner_user_id: string; turn_control_style: string; rpg_stats: unknown; pending_event_triggers: unknown; generation_policy: unknown; model_metadata: unknown }>(
        `SELECT c.owner_user_id,c.turn_control_style,s.rpg_stats,s.pending_event_triggers,t.generation_policy,t.model_metadata
           FROM campaigns c JOIN campaign_state s ON s.campaign_id=c.id JOIN turns t ON t.campaign_id=c.id WHERE c.id=$1`, [importedCampaignId]
      );
      expect(imported.rows[0]).toMatchObject({ owner_user_id: destinationOwner, turn_control_style: "flexible_scene", generation_policy: null,
        rpg_stats: [{ name: "Dormant stat", value: 7 }], pending_event_triggers: [{ event: "dormant" }] });
      expect((imported.rows[0]!.model_metadata as Record<string, unknown>).portableAcceptedGenerationPolicyProvenance).toEqual(
        exportedCampaign.turns[0].portableAcceptedGenerationPolicyProvenance
      );
      const reexport = await buildCampaignArchiveArtifact(pool, { async readOriginal() { throw new Error("No assets expected"); } }, {
        ownerUserId: destinationOwner, campaignId: importedCampaignId, archiveRoot: root, limits,
      });
      const stagedReexport = await stageArchiveUpload(Readable.from(await readFile(reexport.absolutePath)), root, limits);
      const reexportInspection = await inspectArchive(stagedReexport, limits, "campaign");
      const reexportedCampaign = JSON.parse((await readVerifiedEntry(reexportInspection, "campaign.json", limits.maxJsonEntryBytes)).toString("utf8"));
      expect(reexportedCampaign.turns[0].portableAcceptedGenerationPolicyProvenance).toEqual(exportedCampaign.turns[0].portableAcceptedGenerationPolicyProvenance);
      await expect(buildCampaignArchiveArtifact(pool, { async readOriginal() { throw new Error("No assets expected"); } }, {
        ownerUserId: destinationOwner, campaignId: campaign.id, archiveRoot: root, limits,
      })).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await composition?.close();
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
