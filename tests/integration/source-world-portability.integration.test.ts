import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { worldImportRequestSchema, worldContentSchema } from "../../packages/contracts/src/world-library.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresWorldRepositoryAdapters } from "../../packages/database/src/world-repository.js";
import { createPostgresAuthoringRepository } from "../../packages/database/src/authoring-job-repository.js";
import { createPostgresAuthoringWorldApplyAdapter } from "../../packages/database/src/authoring-world-apply-adapter.js";
import { createPostgresChronicleGenerationTransactionPort } from "../../packages/database/src/chronicle-repository.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { buildWorldSourceMaterial, normalizeSourceDocument } from "../../packages/domain/src/source-authoring.js";
import { planSourceChunks } from "../../packages/domain/src/source-authoring-budget.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("source world portable provenance", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });
  afterAll(async () => { await pool?.end(); });

  it("allows only source evidence paths in durable portable import authority", async () => {
    const sourceEvidence = {
      worldImportRequest: {
        worldExport: {
          content: {
            sourceMaterial: {
              fieldEvidence: [{ path: "world.tone", factIds: ["fact:tone"] }]
            }
          }
        }
      }
    };
    const [allowed, rawPath, rootPath, nestedPath, invalidEvidencePath, credential] = await Promise.all([
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify(sourceEvidence)]),
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify({ payload: { filesystem_path: "/private/archive.zip" } })]),
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify({ path: "/private/archive.zip" })]),
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify({ payload: { path: "/private/archive.zip" } })]),
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify({ payload: { sourceMaterial: { fieldEvidence: [{ path: "../../private", factIds: ["fact:tone"] }] } } })]),
      pool.query<{ safe: boolean }>("SELECT portable_import_normalized_payload_is_safe($1::jsonb) AS safe", [JSON.stringify({ payload: { sourceMaterial: { fieldEvidence: [{ path: "world.tone", credential: "private" }] } } })])
    ]);
    expect(allowed.rows[0]?.safe).toBe(true);
    expect(rawPath.rows[0]?.safe).toBe(false);
    expect(rootPath.rows[0]?.safe).toBe(false);
    expect(nestedPath.rows[0]?.safe).toBe(false);
    expect(invalidEvidencePath.rows[0]?.safe).toBe(false);
    expect(credential.rows[0]?.safe).toBe(false);
  });

  it("keeps historical schema-five content and its stored source hash unchanged when exporting", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const title = `Historical source hash ${randomUUID()}`;
    const historical = { schemaVersion: 5, world: { title, tone: "unchanged" }, customLore: { historical: true } };
    const world = await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, title]
    );
    const sourceHash = `historical:${randomUUID()}`;
    const version = await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content,source_hash)
       VALUES ($1,$2,1,$3::jsonb,$4) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify(historical), sourceHash]
    );
    const exported = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
      transaction, { ownerUserId, worldId: world.rows[0]!.id, worldVersionId: version.rows[0]!.id }
    ));
    // Exports use the current portable write shape, but must not rewrite the
    // stored historical snapshot or its immutable source hash.
    expect(exported.content).toMatchObject({ ...historical, schemaVersion: 6 });
    const stored = await pool.query<{ content: unknown; source_hash: string }>(
      "SELECT content,source_hash FROM world_versions WHERE id=$1",
      [version.rows[0]!.id]
    );
    expect(stored.rows).toEqual([{ content: historical, source_hash: sourceHash }]);
  });

  it("exports and imports the selected source prefix while rejecting a tampered appendix", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const source = normalizeSourceDocument("chapter.txt", "The harbor is quiet.\n\nIris wears a blue coat.\n\nEXCLUDED_APPENDIX_SENTINEL", "source:portable");
    const paragraph = source.paragraphs[0]!;
    const characterParagraph = source.paragraphs[1]!;
    const accepted = {
      id: "fact:tone", kind: "tone" as const, subject: "Harbor", predicate: "tone", value: "quiet", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: paragraph.id, start: paragraph.start, end: paragraph.end, quote: "The harbor is quiet." }]
    };
    const characterFact = {
      id: "fact:iris", kind: "character" as const, subject: "Iris", predicate: "clothing", value: "blue coat", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: characterParagraph.id, start: characterParagraph.start, end: characterParagraph.end, quote: "Iris wears a blue coat." }]
    };
    const material = buildWorldSourceMaterial({
      source, boundaryParagraphId: characterParagraph.id, acceptedFacts: [accepted, characterFact],
      fieldEvidence: [
        { path: "world.tone", factIds: [accepted.id] },
        { path: "playableCharacters.source-character:fact:iris.profile.appearance.clothing", factIds: [characterFact.id] }
      ],
      characterIdentityGroups: [{ representativeFactId: characterFact.id, factIds: [characterFact.id] }]
    });
    const title = `Source portability ${randomUUID()}`;
    const content = worldContentSchema.parse({
      world: { title, tone: "quiet" }, sourceMaterial: material,
      playableCharacters: [{ id: "source-character:fact:iris", name: "Iris", characterText: "", profile: { appearance: { clothing: "blue coat" } } }]
    });
    const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction, { ownerUserId }, { title, content }
    ));
    if (!created.ok) throw new Error("source fixture world was not created");
    const published = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction, { ownerUserId, worldId: created.value.id }, { expectedRevision: created.value.draftRevision, releaseNotes: "source appendix" }
    ));
    if (!published.ok) throw new Error("source fixture world was not published");
    const exported = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
      transaction, { ownerUserId, worldId: created.value.id, worldVersionId: published.value.worldVersionId }
    ));
    expect(exported.content.sourceMaterial).toMatchObject({
      documents: [expect.objectContaining({ sha256: material.documents[0]!.sha256, text: "The harbor is quiet.\n\nIris wears a blue coat." })],
      acceptedFacts: [accepted, characterFact],
      characterIdentityGroups: [{ representativeFactId: characterFact.id, factIds: [characterFact.id] }]
    });
    expect(JSON.stringify(exported)).not.toContain("EXCLUDED_APPENDIX_SENTINEL");
    const request = worldImportRequestSchema.parse({ sourceName: "source-world.json", worldExport: exported });
    const destination = await pool.query<{ id: string }>("INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id", [`Source import ${randomUUID()}`]);
    const destinationOwnerUserId = destination.rows[0]!.id;
    const imported = await adapters.transaction.command((transaction) => adapters.worlds.importWorld(transaction, { ownerUserId: destinationOwnerUserId }, request));
    expect(imported).toMatchObject({ ok: true, value: { duplicate: false } });
    if (!imported.ok) throw new Error("source appendix import failed");
    expect(imported.value.worldId).not.toBe(created.value.id);
    const importedExport = await adapters.transaction.read((transaction) => adapters.worlds.exportWorld(
      transaction, { ownerUserId: destinationOwnerUserId, worldId: imported.value.worldId, worldVersionId: imported.value.worldVersionId }
    ));
    expect(importedExport.content.sourceMaterial).toEqual(material);
    const tampered = worldImportRequestSchema.parse({
      sourceName: "tampered.json",
      worldExport: { ...exported, content: { ...exported.content, sourceMaterial: { ...material, documents: [{ ...material.documents[0]!, sha256: "0".repeat(64) }] } } }
    });
    await expect(adapters.transaction.command((transaction) => adapters.worlds.importWorld(transaction, { ownerUserId: destinationOwnerUserId }, tampered)))
      .resolves.toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    const beforeTamperedMapping = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [destinationOwnerUserId]);
    const wrongMapping = worldImportRequestSchema.parse({
      sourceName: "wrong-mapping.json",
      worldExport: {
        ...exported,
        content: {
          ...exported.content,
          sourceMaterial: { ...material, fieldEvidence: [{ path: "world.tone", factIds: [characterFact.id] }] }
        }
      }
    });
    await expect(adapters.transaction.command((transaction) => adapters.worlds.importWorld(transaction, { ownerUserId: destinationOwnerUserId }, wrongMapping)))
      .resolves.toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [destinationOwnerUserId]))
      .resolves.toEqual(beforeTamperedMapping);

    const oversizedRequest = {
      sourceName: "oversized-source-world.json",
      worldExport: {
        ...exported,
        content: {
          ...exported.content,
          sourceMaterial: {
            ...material,
            acceptedFacts: Array.from({ length: 1_100 }, (_, index) => ({
              id: `manual:${index}`, kind: "tone" as const, subject: "Appendix", predicate: "tone", value: "x".repeat(4_000), provenance: "manual" as const, citations: []
            })),
            fieldEvidence: []
          }
        }
      }
    };
    const beforeOversized = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [destinationOwnerUserId]);
    await expect(adapters.transaction.command((transaction) => adapters.worlds.importWorld(
      transaction, { ownerUserId: destinationOwnerUserId }, oversizedRequest as never
    ))).rejects.toThrow();
    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [destinationOwnerUserId]))
      .resolves.toEqual(beforeOversized);
  });

  it("rejects invalid source material at public create, draft update, and publish without writes", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const source = normalizeSourceDocument("public-write.txt", "The harbor is quiet.", `source:public-write:${randomUUID()}`);
    const paragraph = source.paragraphs[0]!;
    const fact = {
      id: "fact:public-tone", kind: "tone" as const, subject: "Harbor", predicate: "tone", value: "quiet", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: paragraph.id, start: paragraph.start, end: paragraph.end, quote: "The harbor is quiet." }]
    };
    const material = buildWorldSourceMaterial({
      source, boundaryParagraphId: paragraph.id, acceptedFacts: [fact], fieldEvidence: [{ path: "world.tone", factIds: [fact.id] }]
    });
    const title = `Public provenance ${randomUUID()}`;
    const valid = worldContentSchema.parse({ world: { title, tone: "quiet" }, sourceMaterial: material });
    const beforeCreate = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [ownerUserId]);
    const invalidCreate = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction,
      { ownerUserId },
      { title: `${title} invalid`, content: { ...valid, sourceMaterial: { ...material, documents: [{ ...material.documents[0]!, sha256: "0".repeat(64) }] } } }
    ));
    expect(invalidCreate).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds WHERE owner_user_id=$1", [ownerUserId]))
      .resolves.toEqual(beforeCreate);

    const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction, { ownerUserId }, { title, content: valid }
    ));
    if (!created.ok) throw new Error("valid source fixture world was not created");
    const staleContent = worldContentSchema.parse({ ...valid, world: { ...valid.world, tone: "manually edited" } });
    const staleUpdate = await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: created.value.id },
      { expectedRevision: created.value.draftRevision, content: staleContent }
    ));
    expect(staleUpdate).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    const afterStale = await pool.query<{ revision: number; content: unknown }>(
      "SELECT revision,content FROM world_drafts WHERE world_id=$1 AND owner_user_id=$2",
      [created.value.id, ownerUserId]
    );
    expect(afterStale.rows).toEqual([{ revision: created.value.draftRevision, content: valid }]);

    // A client may mark an edited value manual by removing its stale mapping;
    // the accepted source inventory remains portable and publishable.
    const manualContent = worldContentSchema.parse({
      ...staleContent,
      sourceMaterial: { ...material, fieldEvidence: [] }
    });
    const manualUpdate = await adapters.transaction.command((transaction) => adapters.worlds.updateWorldDraft(
      transaction,
      { ownerUserId, worldId: created.value.id },
      { expectedRevision: created.value.draftRevision, content: manualContent }
    ));
    expect(manualUpdate).toMatchObject({ ok: true });
    if (!manualUpdate.ok) throw new Error("manual source edit fixture was not saved");

    // Simulate a legacy/corrupt persisted draft; publish must revalidate before
    // allocating a version or changing the draft/world state.
    const corrupted = { ...manualContent, sourceMaterial: { ...material, fieldEvidence: [{ path: "world.tone", factIds: [fact.id] }] } };
    await pool.query(
      "UPDATE world_drafts SET content=$3::jsonb WHERE world_id=$1 AND owner_user_id=$2",
      [created.value.id, ownerUserId, JSON.stringify(corrupted)]
    );
    const beforePublish = await pool.query<{ version_count: string; revision: number; content: unknown }>(
      `SELECT (SELECT count(*)::text FROM world_versions WHERE world_id=$1 AND owner_user_id=$2) AS version_count,
              draft.revision,draft.content
         FROM world_drafts draft WHERE draft.world_id=$1 AND draft.owner_user_id=$2`,
      [created.value.id, ownerUserId]
    );
    const publish = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction,
      { ownerUserId, worldId: created.value.id },
      { expectedRevision: manualUpdate.value.revision, releaseNotes: "must reject corrupt source evidence" }
    ));
    expect(publish).toMatchObject({ ok: false, failure: { reason: "invalid_transition" } });
    await expect(pool.query<{ version_count: string; revision: number; content: unknown }>(
      `SELECT (SELECT count(*)::text FROM world_versions WHERE world_id=$1 AND owner_user_id=$2) AS version_count,
              draft.revision,draft.content
         FROM world_drafts draft WHERE draft.world_id=$1 AND draft.owner_user_id=$2`,
      [created.value.id, ownerUserId]
    )).resolves.toEqual(beforePublish);
  });

  it("removes stale source evidence from manually changed content before operational stage scrub", async () => {
    const repository = createPostgresAuthoringRepository(pool);
    const text = "The harbor is quiet.\n\nEXCLUDED_APPLY_TAIL";
    const submitted = await repository.submit({ ownerUserId }, {
      kind: "story_source", idempotencyKey: randomUUID(), target: { kind: "new_world" }, name: "apply.txt", text,
      mode: "faithful", boundaryParagraphId: "paragraph:0", instructions: ""
    }, createHash("sha256").update(text).digest("hex"));
    const source = normalizeSourceDocument("apply.txt", text, submitted.id);
    const chunks = planSourceChunks({ source, boundaryParagraphId: "paragraph:0", systemPrompt: "source", instructions: "", budget: { contextWindowTokens: 10_000, maxOutputTokens: 100, countTokens: (value) => Buffer.byteLength(value, "utf8") } });
    const plan = await repository.claim("source-apply-plan", 60);
    await repository.initializeExecutionSnapshot(plan!, { providerProfileId: randomUUID(), model: "test", configurationHash: "a".repeat(64), contextWindowTokens: 10_000, maxOutputTokens: 100, requestTimeoutMs: 1_000, prompts: {}, protocols: { source: "test" } });
    await repository.checkpoint(plan!, { kind: "source_plan", chunks });
    const chunk = chunks[0]!;
    const paragraph = source.paragraphs[0]!;
    const extraction = await repository.claim("source-apply-extraction", 60);
    await repository.checkpoint(extraction!, { kind: "source_extraction", facts: [{
      id: "raw-tone", kind: "tone", subject: "Harbor", predicate: "tone", value: "quiet", provenance: "stated",
      citations: [{ sourceId: source.id, paragraphId: paragraph.id, start: paragraph.start, end: paragraph.end, quote: "The harbor is quiet." }]
    }] });
    const extracted = await repository.read({ ownerUserId }, submitted.id);
    if (!extracted || extracted.kind !== "story_source") throw new Error("source extraction fixture failed");
    const fact = extracted.source!.facts[0]!;
    const reviewed = await repository.reviewSourceFacts!({ ownerUserId }, submitted.id, {
      expectedRevision: extracted.revision, acceptedFactIds: [fact.id], rejectedFactIds: [], uncertainFactIds: [], selectedCharacterFactIds: [], characterIdentityGroups: [], manualFacts: []
    });
    await repository.startSourceSynthesis!({ ownerUserId }, submitted.id, reviewed.revision);
    const synthesis = await repository.claim("source-apply-synthesis", 60);
    await repository.checkpoint(synthesis!, { kind: "source_world", proposal: { world: { title: "Applied source", tone: "manually adjusted" }, playableCharacters: [], entities: [], relationships: [], rpgStats: [], defaultTriggers: [], eventTriggers: [], assets: [], defaults: {} }, mappings: [{ target: "world", path: "world.tone", value: "quiet", supportingFactIds: [fact.id] }] });
    const ready = await repository.read({ ownerUserId }, submitted.id);
    if (!ready || ready.kind !== "story_source" || !ready.result) throw new Error("source synthesis fixture failed");
    expect(ready.canApply).toBe(true);
    const stageId = ready.stages.find((stage) => stage.key === "source:synthesis")!.id;
    const beforeApplyWorlds = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM world_drafts WHERE owner_user_id = $1", [ownerUserId]);
    const applyInput = { expectedRevision: ready.revision, idempotencyKey: randomUUID(), selectedStageIds: [stageId], content: ready.result };
    const applyHash = "b".repeat(64);
    const applied = await repository.apply({ ownerUserId }, submitted.id, applyInput, applyHash, createPostgresAuthoringWorldApplyAdapter());
    const replay = await repository.apply({ ownerUserId }, submitted.id, applyInput, applyHash, createPostgresAuthoringWorldApplyAdapter());
    expect(replay).toEqual(applied);
    await expect(pool.query("SELECT count(*)::int AS count FROM world_drafts WHERE owner_user_id = $1", [ownerUserId]))
      .resolves.toMatchObject({ rows: [{ count: beforeApplyWorlds.rows[0]!.count + 1 }] });
    const persisted = await pool.query<{ content: unknown }>("SELECT content FROM world_drafts WHERE owner_user_id = $1 AND world_id = $2", [ownerUserId, applied.worldId]);
    const saved = worldContentSchema.parse(persisted.rows[0]!.content);
    const expectedMaterial = buildWorldSourceMaterial({
      source, boundaryParagraphId: "paragraph:0", acceptedFacts: [fact],
      fieldEvidence: [], characterIdentityGroups: []
    });
    expect(saved.sourceMaterial).toEqual(expectedMaterial);
    await expect(pool.query<{ input: unknown; execution_snapshot: unknown; source_plan: unknown; source_review: unknown }>("SELECT input,execution_snapshot,source_plan,source_review FROM authoring_jobs WHERE id=$1", [submitted.id]))
      .resolves.toMatchObject({ rows: [{ input: { applied: true }, execution_snapshot: null, source_plan: null, source_review: null }] });
    const scrubbedStages = await pool.query<{ output: unknown; failure: unknown }>("SELECT output,failure FROM authoring_job_stages WHERE job_id=$1", [submitted.id]);
    expect(scrubbedStages.rows).not.toHaveLength(0);
    expect(scrubbedStages.rows.every((stage) => stage.output === null && stage.failure === null)).toBe(true);
  });

  it("keeps appendix-only text out of the real PostgreSQL Story authority projection", async () => {
    const adapters = createPostgresWorldRepositoryAdapters(pool, { memory: { async autoEnableCampaignEmbedding() { return { enabled: false }; } } });
    const source = normalizeSourceDocument(
      "projection.txt",
      "APPENDIX_RETAINED_ONLY_SENTINEL\n\nApproved story tone.\n\nAPPENDIX_ONLY_STORY_SENTINEL",
      `source:projection:${randomUUID()}`
    );
    const paragraph = source.paragraphs[1]!;
    const fact = {
      id: "fact:projection-tone", kind: "tone" as const, subject: "Projection World", predicate: "tone", value: "approved canon", provenance: "stated" as const,
      citations: [{ sourceId: source.id, paragraphId: paragraph.id, start: paragraph.start, end: paragraph.end, quote: "Approved story tone." }]
    };
    const material = buildWorldSourceMaterial({ source, boundaryParagraphId: paragraph.id, acceptedFacts: [fact], fieldEvidence: [{ path: "world.tone", factIds: [fact.id] }] });
    expect(material.documents[0]!.text).toContain("APPENDIX_RETAINED_ONLY_SENTINEL");
    const title = `Projection world ${randomUUID()}`;
    const created = await adapters.transaction.command((transaction) => adapters.worlds.createWorld(
      transaction, { ownerUserId }, { title, content: worldContentSchema.parse({ world: { title, tone: "approved canon" }, sourceMaterial: material }) }
    ));
    if (!created.ok) throw new Error("projection world was not created");
    const published = await adapters.transaction.command((transaction) => adapters.worlds.publishWorld(
      transaction, { ownerUserId, worldId: created.value.id }, { expectedRevision: created.value.draftRevision, releaseNotes: "projection" }
    ));
    if (!published.ok) throw new Error("projection world was not published");
    const campaign = await pool.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number,turn_control_style) VALUES ($1,$2,$3,0,'flexible_auto') RETURNING id",
      [ownerUserId, published.value.worldVersionId, `Projection campaign ${randomUUID()}`]
    );
    const campaignId = campaign.rows[0]!.id;
    await pool.query("INSERT INTO campaign_state (campaign_id,owner_user_id) VALUES ($1,$2)", [campaignId, ownerUserId]);
    const embeddingProvider = await pool.query<{ id: string }>(
      `INSERT INTO provider_profiles
         (owner_user_id,name,provider_type,provider_role,base_url,default_model)
       VALUES ($1,$2,'openai_compatible','embedding','http://fixture.invalid/v1','source-projection-embed-v1')
       RETURNING id`,
      [ownerUserId, `Projection embedding ${randomUUID()}`]
    );
    const embeddingProviderId = embeddingProvider.rows[0]!.id;
    await pool.query(
      `INSERT INTO campaign_memory_configs
         (campaign_id,owner_user_id,embedding_enabled,embedding_provider_profile_id,embedding_model,
          retrieval_implementation,retrieval_shadow_enabled)
       VALUES ($1,$2,true,$3,'source-projection-embed-v1','legacy_hybrid',false)`,
      [campaignId, ownerUserId, embeddingProviderId]
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const context = await loadPostgresChronicleGenerationAuthorityContext(client, {
        ownerUserId, campaignId, worldVersionId: published.value.worldVersionId,
        operationKind: "append", expectedTurnNumber: 0, query: "approved canon"
      });
      const serialized = JSON.stringify(context.authority);
      expect(serialized).toContain("approved canon");
      expect(serialized).not.toContain("APPENDIX_RETAINED_ONLY_SENTINEL");
      expect(serialized).not.toContain("APPENDIX_ONLY_STORY_SENTINEL");
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const embeddedInputs: string[] = [];
    const chronicle = createPostgresChronicleGenerationTransactionPort({
      embeddings: {
        async resolve(_database, requested) {
          return requested.selectedProviderProfileId === embeddingProviderId
            ? {
                status: "resolved" as const,
                resolutionSource: "dedicated_embedding" as const,
                resolvedRole: "embedding" as const,
                providerProfileId: embeddingProviderId,
                providerType: "openai_compatible",
                model: "source-projection-embed-v1"
              }
            : { status: "unconfigured" as const, resolutionSource: "none" as const, resolvedRole: null };
        },
        async load() {
          return {
            id: embeddingProviderId,
            model: "source-projection-embed-v1",
            providerType: "openai_compatible",
            configuration: { embeddingDimensions: 2 },
            async embed(documents: readonly string[]) {
              return { embeddings: documents.map(() => [1, 0]), responseId: "fixture", usage: {}, reportedCost: null };
            }
          };
        },
        async embed(provider, documents) {
          embeddedInputs.push(...documents);
          return provider.embed(documents);
        },
        async fingerprint() { return "source-projection-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    });
    const preview = await chronicle.buildContextPreview(pool, {
      ownerUserId, campaignId, worldVersionId: published.value.worldVersionId,
      request: { budgetTokens: 2_048, compression: "full", query: "approved canon", recentTurns: 1 }
    });
    expect(embeddedInputs).toEqual(["approved canon"]);
    expect(JSON.stringify(preview.scopes)).not.toContain("APPENDIX_RETAINED_ONLY_SENTINEL");
    expect(JSON.stringify(preview.scopes)).not.toContain("APPENDIX_ONLY_STORY_SENTINEL");
  });
});
