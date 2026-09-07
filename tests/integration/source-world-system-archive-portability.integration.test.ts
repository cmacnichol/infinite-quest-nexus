import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { systemRecordEnvelopeSchema } from "../../packages/contracts/src/system-archives.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPostgresSystemArchiveExportRepository } from "../../packages/database/src/system-archive-export-repository.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";
import { buildWorldSourceMaterial, normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("source world System Archive portability", () => {
  let pool: DatabasePool;
  let initialOwnerUserId: string;

  beforeAll(async () => {
    const isolated = new URL(databaseUrl!);
    expect(isolated.pathname).toMatch(/^\/infinitequest_test_[a-f0-9]{32}$/u);
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    initialOwnerUserId = await initialOwnerId(pool);
    // This dedicated file exercises the System Archive's intentionally-empty
    // installation gate; no shared test scenario state is used.
    await pool.query("TRUNCATE TABLE worlds,provider_profiles,authoring_jobs,imports,activity_events,system_archive_jobs,system_archive_uploads RESTART IDENTITY CASCADE");
    await pool.query("DELETE FROM users WHERE system_key IS DISTINCT FROM 'initial-owner'");
  });
  afterAll(async () => { await pool?.end(); });

  it("exports, atomically rejects tampering, and restores version plus draft provenance", async () => {
    const sourceOwner = await pool.query<{ id: string }>("INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id", [`System archive source ${randomUUID()}`]);
    const sourceOwnerUserId = sourceOwner.rows[0]!.id;
    const source = normalizeSourceDocument(
      "system.txt",
      "System archive source canon.\n\nIris wears a blue coat.\n\nIris wears a red coat.\n\nEXCLUDED_SYSTEM_APPENDIX_TAIL",
      `source:system:${randomUUID()}`
    );
    const [toneParagraph, blueParagraph, redParagraph] = source.paragraphs;
    const toneFact = {
      id: "fact:system-tone", kind: "tone" as const, subject: "Archive World", predicate: "tone", value: "quiet", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: toneParagraph!.id, start: toneParagraph!.start, end: toneParagraph!.end, quote: "System archive source canon." }]
    };
    const blueFact = {
      id: "fact:iris-blue", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: blueParagraph!.id, start: blueParagraph!.start, end: blueParagraph!.end, quote: "Iris wears a blue coat." }]
    };
    const redFact = {
      id: "fact:iris-red", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "red coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: redParagraph!.id, start: redParagraph!.start, end: redParagraph!.end, quote: "Iris wears a red coat." }]
    };
    const characterId = `source-character:${blueFact.id}`;
    const appearancePath = `playableCharacters.${characterId}.profile.appearance.clothing`;
    const material = buildWorldSourceMaterial({
      source, boundaryParagraphId: redParagraph!.id, acceptedFacts: [toneFact, blueFact, redFact],
      fieldEvidence: [
        { path: "world.tone", factIds: [toneFact.id] },
        { path: appearancePath, factIds: [blueFact.id] }
      ],
      characterIdentityGroups: [
        { representativeFactId: blueFact.id, factIds: [blueFact.id] },
        { representativeFactId: redFact.id, factIds: [redFact.id] }
      ]
    });
    const title = `System source ${randomUUID()}`;
    const worlds = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const created = await worlds.transaction.command((transaction) => worlds.worlds.createWorld(
      transaction, { ownerUserId: sourceOwnerUserId }, {
        title,
        content: worldContentSchema.parse({
          world: { title, tone: "quiet" },
          playableCharacters: [{ id: characterId, name: "Iris", characterText: "A blue-coated Iris.", profile: { appearance: { clothing: "blue coat" } } }],
          sourceMaterial: material
        })
      }
    ));
    if (!created.ok) throw new Error("System archive fixture world was not created");
    await worlds.transaction.command((transaction) => worlds.worlds.publishWorld(
      transaction, { ownerUserId: sourceOwnerUserId, worldId: created.value.id }, { expectedRevision: created.value.draftRevision, releaseNotes: "source archive" }
    ));

    const exporter = createPostgresSystemArchiveExportRepository(pool, { pageSize: 10, sourceApplicationVersion: "0.1.0" });
    const records = await exporter.withOwnerSnapshot({ ownerUserId: sourceOwnerUserId }, async (snapshot) => {
      const exported = [];
      for (const domain of ["worlds", "world-versions", "world-drafts"] as const) {
        for await (const record of snapshot.streamDomain(domain)) exported.push(record);
      }
      return exported;
    });
    expect(records.filter((record) => record.domain !== "worlds")).toEqual(expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ content: expect.objectContaining({ sourceMaterial: material }) }) })
    ]));
    expect(JSON.stringify(records)).not.toContain("EXCLUDED_SYSTEM_APPENDIX_TAIL");

    await pool.query("DELETE FROM world_drafts WHERE world_id=$1 AND owner_user_id=$2", [created.value.id, sourceOwnerUserId]);
    await pool.query("DELETE FROM world_versions WHERE world_id=$1 AND owner_user_id=$2", [created.value.id, sourceOwnerUserId]);
    await pool.query("DELETE FROM worlds WHERE id=$1 AND owner_user_id=$2", [created.value.id, sourceOwnerUserId]);
    await pool.query("DELETE FROM activity_events WHERE owner_user_id=$1", [sourceOwnerUserId]);
    await pool.query("DELETE FROM users WHERE id=$1", [sourceOwnerUserId]);

    const imports = createPostgresSystemArchiveImportRepository(pool);
    const destination = await imports.destinationFingerprint({ ownerUserId: initialOwnerUserId }, {});
    const tampered = records.map((record) => record.domain !== "world-versions" ? record : systemRecordEnvelopeSchema.parse({
      ...record,
      record: {
        ...record.record,
        content: {
          ...record.record.content,
          sourceMaterial: {
            ...material,
            fieldEvidence: [
              { path: "world.tone", factIds: [toneFact.id] },
              { path: appearancePath, factIds: [redFact.id] }
            ]
          }
        }
      }
    }));
    await expect(imports.withAtomicImport({ ownerUserId: initialOwnerUserId }, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(tampered);
    })).rejects.toMatchObject({ statusCode: 400 });
    await expect(pool.query("SELECT id FROM worlds WHERE id=$1", [created.value.id])).resolves.toMatchObject({ rows: [] });

    await imports.withAtomicImport({ ownerUserId: initialOwnerUserId }, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(records);
    });
    const restored = await pool.query<{ owner_user_id: string; content: unknown }>(
      `SELECT version.owner_user_id,version.content
         FROM world_versions version
        WHERE version.world_id=$1
        UNION ALL
       SELECT draft.owner_user_id,draft.content
         FROM world_drafts draft
        WHERE draft.world_id=$1`,
      [created.value.id]
    );
    expect(restored.rows).toHaveLength(2);
    expect(restored.rows.every((row) => row.owner_user_id === initialOwnerUserId)).toBe(true);
    expect(restored.rows.map((row) => worldContentSchema.parse(row.content).sourceMaterial)).toEqual([material, material]);
  });
});
