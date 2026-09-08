import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeWorldContent, worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createDatabasePool, initialOwnerId } from "../../packages/database/src/pool.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { buildWorldSourceMaterial, normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { buildCampaignArchiveArtifact } from "../../services/runtime/src/campaign-archive-export-composition.js";
import { createPortableImportExportComposition } from "../../services/runtime/src/portable-import-export-composition.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("source campaign portability", () => {
  it("transfers source evidence to a new owner through production campaign archive services", async () => {
    const pool = createDatabasePool(databaseUrl!, 4);
    const root = await mkdtemp(join(tmpdir(), "iq-source-campaign-"));
    let composition: Awaited<ReturnType<typeof createPortableImportExportComposition>> | undefined;
    try {
      await migrateDatabase(pool, resolve("database/migrations"));
      const sourceOwner = await initialOwnerId(pool);
      const destination = await pool.query<{ id: string }>(
        "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id", [`Destination ${randomUUID()}`]
      );
      const destinationOwner = destination.rows[0]!.id;
      const selectedText = "Iris wears a blue coat. APPENDIX_ONLY_SOURCE_SENTINEL";
      const excludedText = "EXCLUDED_TAIL_SENTINEL";
      const source = normalizeSourceDocument("chapter.txt", `${selectedText}\n\n${excludedText}`, "source:archive");
      const fact = {
        id: "fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat",
        provenance: "stated" as const,
        citations: [{ sourceId: source.id, paragraphId: "paragraph:0", start: 0, end: selectedText.length, quote: selectedText }]
      };
      const characterId = `source-character:${fact.id}`;
      const sourceMaterial = buildWorldSourceMaterial({
        source, boundaryParagraphId: "paragraph:0", acceptedFacts: [fact],
        fieldEvidence: [{ path: `playableCharacters.${characterId}.profile.appearance.clothing`, factIds: [fact.id] }],
        characterIdentityGroups: [{ representativeFactId: fact.id, factIds: [fact.id] }]
      });
      const content = canonicalizeWorldContent({
        world: { title: "Source campaign", tone: "ACCEPTED_CANON_MARKER" },
        playableCharacters: [{ id: characterId, name: "Iris", characterText: "A traveler in a blue coat.", profile: { appearance: { clothing: fact.value } } }],
        sourceMaterial
      });
      const adapters = createPostgresWorldRepositoryAdapters(pool, {
        memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } }
      });
      const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
        transaction, { ownerUserId: sourceOwner }, { title: content.world.title, content }
      ));
      if (!created.ok) throw new Error("Source world fixture failed");
      const published = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
        transaction, { ownerUserId: sourceOwner, worldId: created.value.id },
        { expectedRevision: created.value.draftRevision, releaseNotes: "Source campaign fixture" }
      ));
      if (!published.ok) throw new Error("Source version fixture failed");
      const campaign = await pool.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id,world_version_id,title) VALUES ($1,$2,'Source campaign') RETURNING id",
        [sourceOwner, published.value.worldVersionId]
      );
      const campaignId = campaign.rows[0]!.id;
      await pool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)", [campaignId, sourceOwner]);
      const artifact = await buildCampaignArchiveArtifact(pool, {
        async readOriginal() { throw new Error("No image assets expected"); }
      }, {
        ownerUserId: sourceOwner, campaignId, archiveRoot: root,
        limits: { maxCompressedBytes: 10000000, maxUncompressedBytes: 50000000, maxEntries: 1000,
          maxManifestBytes: 1000000, maxJsonEntryBytes: 5000000, maxExpansionRatio: 100, maxOriginalImageBytes: 25000000 }
      });
      const bytes = await readFile(artifact.absolutePath);
      await Promise.all([mkdir(join(root, "imports")), mkdir(join(root, "assets"))]);
      composition = await createPortableImportExportComposition({
        pool, worlds: adapters.worlds, roots: { archiveRoot: join(root, "imports"), assetRoot: join(root, "assets") },
        leaseOwner: "source-campaign-portability",
        provider: { async convertTemplate() { throw new Error("Archive import must not generate content"); } },
        targets: { async readTargetWorldVersion() { throw new Error("Embedded import must not reuse a target"); } },
        exports: {
          async buildCampaignArchive() { throw new Error("Already exported through production builder"); },
          async buildWorldJson() { throw new Error("World JSON export not expected"); }
        }
      });
      const staged = await composition.stageInput({
        owner: { ownerUserId: destinationOwner }, operationScopeId: `source-campaign-${randomUUID()}`,
        leaseOwner: "source-campaign-stage", expiresAt: new Date(Date.now() + 3600000).toISOString(),
        byteLength: bytes.byteLength, source: [bytes]
      });
      const preview = await composition.previewCampaignZip({
        ownerUserId: destinationOwner, stagedInput: staged.stagedInput, kind: "campaign_zip",
        destination: { kind: "embedded", operation: "create_world" }
      });
      const imported = await composition.commit({
        ownerUserId: destinationOwner, kind: "campaign_zip", destination: preview.destination,
        previewHandle: preview.previewHandle, idempotencyKey: `source-campaign-import-${randomUUID()}`
      });
      if (imported.kind !== "campaign_zip") throw new Error("Unexpected import result kind");
      if (!("campaignId" in imported.result) || !("worldId" in imported.result) || !("worldVersionId" in imported.result)) {
        throw new Error("Campaign import result is incomplete");
      }
      expect(imported.result.worldId).not.toBe(created.value.id);
      expect(imported.result.worldVersionId).not.toBe(published.value.worldVersionId);
      expect(imported.result.campaignId).not.toBe(campaignId);
      const saved = await pool.query<{ owner_user_id: string; content: unknown }>(
        "SELECT owner_user_id,content FROM world_versions WHERE id=$1", [imported.result.worldVersionId]
      );
      expect(saved.rows).toHaveLength(1);
      expect(saved.rows[0]!.owner_user_id).toBe(destinationOwner);
      const restored = worldContentSchema.parse(saved.rows[0]!.content);
      expect(restored.sourceMaterial).toEqual(sourceMaterial);
      expect(restored.sourceMaterial!.documents[0]!.text).toBe(selectedText);
      expect(JSON.stringify(restored)).not.toContain(excludedText);
      expect(restored.world.tone).toBe("ACCEPTED_CANON_MARKER");
    } finally {
      await composition?.close();
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  });
});
