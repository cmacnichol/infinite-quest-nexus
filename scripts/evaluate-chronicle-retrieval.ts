import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresChronicleGenerationTransactionPort } from "../packages/database/src/chronicle-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabaseClient } from "../packages/database/src/pool.js";
import { migrateDatabase } from "../packages/database/src/migrate.js";
import { CHRONICLE_CHUNK_PROTOCOL_VERSION, chunkChronicleMemory } from "../packages/domain/src/chronicle-chunking.js";
import { CHRONICLE_RETRIEVAL_PROFILE_V2 } from "../packages/domain/src/generated/chronicle-retrieval-profile-v2.js";
import {
  CHRONICLE_EMBEDDING_PROTOCOL_VERSION,
  chronicleContentHash
} from "../packages/domain/src/chronicle-memory-helpers.js";
import { ensureTestDatabase } from "./ensure-test-database.mjs";
import {
  calibrateChronicleRetrievalProfile,
  chronicleProductionRankFusionProfile,
  chronicleRetrievalCorpusHash,
  deterministicChronicleEvaluationUuid,
  evaluateChronicleRetrieval,
  renderChronicleRetrievalProfileModule,
  type ChronicleEvaluationReport,
  type ChronicleRetrievalApplication,
  type ChronicleRetrievalCorpus,
  type ChronicleLongParentFixture,
  type ChronicleRetrievalProfileV2
} from "./lib/chronicle-retrieval-evaluator.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = "tmp/chronicle-evaluation/legacy-baseline.json";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resolveRepositoryCorpusPath(corpusArgument: string | undefined): string {
  const corpusPath = resolve(root, corpusArgument ?? "tests/fixtures/chronicle-retrieval-evaluation.v2.json");
  const pathFromRoot = relative(root, corpusPath);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("Chronicle evaluation corpus must be contained within the repository root.");
  }
  return corpusPath;
}

async function loadCorpus(corpusPath: string): Promise<ChronicleRetrievalCorpus> {
  return JSON.parse(await readFile(corpusPath, "utf8")) as ChronicleRetrievalCorpus;
}

function longParentContent(fixture: ChronicleLongParentFixture): string {
  if (!Number.isSafeInteger(fixture.paragraphCount) || fixture.paragraphCount < 2) {
    throw new Error("Chronicle evaluation long parent requires at least two paragraphs.");
  }
  if (!Number.isSafeInteger(fixture.relevantParagraphIndex)
    || fixture.relevantParagraphIndex < 0
    || fixture.relevantParagraphIndex >= fixture.paragraphCount) {
    throw new Error("Chronicle evaluation relevant paragraph index is out of range.");
  }
  return Array.from({ length: fixture.paragraphCount }, (_, index) => (
    index === fixture.relevantParagraphIndex
      ? fixture.relevantParagraph
      : `Sanitized continuity filler paragraph ${index + 1} describing quiet roads and empty courtyards.`
  )).join("\n\n");
}

function retrievalApplication(
  rankFusionProfile?: Parameters<typeof createPostgresChronicleGenerationTransactionPort>[0]["rankFusionProfile"],
): ChronicleRetrievalApplication {
  const vectorFor = (text: string): readonly number[] => (
    text.includes("amber agreement") || text.includes("moon sigil western gate") ? [1, 0] : [0, 1]
  );
  const provider = {
    id: "fixture-embedding-provider",
    model: "fixture-embedding-v1",
    providerType: "openai_compatible",
    async embed(documents: readonly string[]) {
      return { embeddings: documents.map(vectorFor), responseId: "fixture-embedding", usage: {}, reportedCost: null };
    }
  };
  return {
    generation: createPostgresChronicleGenerationTransactionPort({
      ...(rankFusionProfile ? { rankFusionProfile } : {}),
      embeddings: {
        async resolve(_database, scope) {
          return scope.selectedProviderProfileId
            ? {
                status: "resolved" as const,
                resolutionSource: "dedicated_embedding" as const,
                resolvedRole: "embedding" as const,
                providerProfileId: scope.selectedProviderProfileId,
                providerType: provider.providerType,
                model: provider.model
              }
            : {
                status: "unconfigured" as const,
                resolutionSource: "none" as const,
                resolvedRole: null
              };
        },
        async load() { return provider; },
        async embed(loadedProvider, documents) { return loadedProvider.embed(documents); },
        async fingerprint() { return "fixture-embedding-fingerprint"; },
        async recordHealth() {},
        async recordCost() { return null; },
        logDiagnostic() {}
      }
    })
  };
}

async function seedCorpus(
  database: DatabaseClient,
  ownerUserId: string,
  corpus: ChronicleRetrievalCorpus,
  retrievalImplementation: "legacy_hybrid" | "chunked_hybrid",
): Promise<ChronicleRetrievalCorpus> {
  const cases: ChronicleRetrievalCorpus["cases"][number][] = [];
  for (const fixture of corpus.cases) {
    const evaluationUuid = (role: string): string => (
      deterministicChronicleEvaluationUuid(corpus.version, fixture.id, role)
    );
    const semantic = fixture.id === "paraphrase" || fixture.id === "character-alias" || fixture.id === "location-alias" || Boolean(fixture.longParent);
    const fixtureTitle = fixture.id === "superseded-fact" ? "E" : `Chronicle evaluator ${fixture.id}`;
    const world = await database.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, fixtureTitle]
    );
    const version = await database.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: fixture.id === "superseded-fact" ? "E" : fixture.id }, entities: [] })]
    );
    const campaign = await database.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, fixtureTitle]
    );
    await database.query(
      "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
      [campaign.rows[0]!.id, ownerUserId]
    );
    const firstTurn = await database.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,1,'Sanitized fixture action one.','Sanitized fixture narration one.','{}'::jsonb) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id]
    );
    const secondTurn = await database.query<{ id: string }>(
      `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
       VALUES ($1,$2,2,'Sanitized fixture action two.','Sanitized fixture narration two.','{}'::jsonb) RETURNING id`,
      [ownerUserId, campaign.rows[0]!.id]
    );
    const replacedFact = await database.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number, source_fact_index,
          content, normalized_content, valid_from_turn, valid_until_turn)
       VALUES ($1,$2,$3,$4,$5,1,0,'Sanitized replaced fact.','sanitized replaced fact.',1,2) RETURNING id`,
      [
        evaluationUuid("fact:replaced"),
        ownerUserId,
        campaign.rows[0]!.id,
        version.rows[0]!.id,
        firstTurn.rows[0]!.id
      ]
    );
    const replacementFactContent = fixture.id === "superseded-fact"
      ? "Superseded fact."
      : "Sanitized replacement fact.";
    const replacementFact = await database.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number, source_fact_index,
          content, normalized_content, valid_from_turn)
       VALUES ($1,$2,$3,$4,$5,2,0,$6,$7,2) RETURNING id`,
      [
        evaluationUuid("fact:replacement"),
        ownerUserId,
        campaign.rows[0]!.id,
        version.rows[0]!.id,
        secondTurn.rows[0]!.id,
        replacementFactContent,
        replacementFactContent.toLowerCase()
      ]
    );
    await database.query(
      "UPDATE campaign_canonical_facts SET superseded_by_fact_id = $1 WHERE id = $2",
      [replacementFact.rows[0]!.id, replacedFact.rows[0]!.id]
    );
    const labelByMemoryId: Record<string, string> = {};
    let embeddingProviderId: string | null = null;
    if (semantic) {
      const profile = await database.query<{ id: string }>(
        `INSERT INTO provider_profiles
           (owner_user_id, name, provider_type, provider_role, base_url, default_model)
         VALUES ($1,$2,'openai_compatible','embedding','http://fixture.invalid/v1','fixture-embedding-v1') RETURNING id`,
        [ownerUserId, `Chronicle evaluator embedding ${fixture.id}`]
      );
      embeddingProviderId = profile.rows[0]!.id;
      const lexicalDecoyCount = fixture.id === "paraphrase" ? 6 : fixture.id === "character-alias" ? 6 : 5;
      for (let index = 0; index < lexicalDecoyCount; index += 1) {
        const turn = await database.query<{ id: string }>(
          `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
           VALUES ($1,$2,$3,'Sanitized lexical fixture action.','Sanitized lexical fixture narration.','{}'::jsonb) RETURNING id`,
          [ownerUserId, campaign.rows[0]!.id, index + 3]
        );
        const content = `amber agreement lexical relay ${index + 1}`;
        const decoy = await database.query<{ id: string }>(
          `INSERT INTO chronicle_memories
             (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate,
              embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
              embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint, id)
           VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,1,'[0,1]'::vector,$7,'fixture-embedding-v1',2,$8,now(),'fixture-embedding-fingerprint',$9)
           RETURNING id`,
          [
            ownerUserId,
            campaign.rows[0]!.id,
            version.rows[0]!.id,
            turn.rows[0]!.id,
            index + 2,
            content,
            embeddingProviderId,
            chronicleContentHash(content),
            evaluationUuid(`memory:semantic-lexical-decoy:${index}`)
          ]
        );
        labelByMemoryId[decoy.rows[0]!.id] = `semantic-lexical-decoy-${index + 1}`;
      }
    }
    for (const [index, label] of fixture.expectedLabels.entries()) {
      const content = fixture.longParent && index === 0
        ? longParentContent(fixture.longParent)
        : semantic ? "azure beacon confirmation" : `sanitized record ${fixture.id} ${index + 1}`;
      const ordinal = semantic ? index + 32 : index + 1;
      const memory = semantic
        ? await database.query<{ id: string }>(
         `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, metadata,
            embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
            embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint, id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8::vector,$9,$10,$11,$12,now(),$13,$14) RETURNING id`,
        [
          ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, index === 0 ? "campaign_summary" : "canonical_fact", ordinal,
          content,
          JSON.stringify(index === 0 || retrievalImplementation === "legacy_hybrid"
            ? {}
            : { structuredFactIds: [replacementFact.rows[0]!.id] }),
          "[1,0]", embeddingProviderId, "fixture-embedding-v1", 2, chronicleContentHash(content), "fixture-embedding-fingerprint",
          evaluationUuid(`memory:expected:${index}`)
        ]
      )
        : await database.query<{ id: string }>(
          `INSERT INTO chronicle_memories
             (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, metadata, id)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,$8) RETURNING id`,
          [
            ownerUserId,
            campaign.rows[0]!.id,
            version.rows[0]!.id,
            index === 0 ? "campaign_summary" : "canonical_fact",
            ordinal,
            content,
            JSON.stringify(index === 0 || retrievalImplementation === "legacy_hybrid"
              ? {}
              : { structuredFactIds: [replacementFact.rows[0]!.id] }),
            evaluationUuid(`memory:expected:${index}`)
          ]
        );
      labelByMemoryId[memory.rows[0]!.id] = label;
    }
    for (const [index, label] of (fixture.forbiddenLabels?.futureTurn ?? []).entries()) {
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, id)
         VALUES ($1,$2,$3,'canonical_fact',$4,$5,1,$6) RETURNING id`,
        [
          ownerUserId,
          campaign.rows[0]!.id,
          version.rows[0]!.id,
          (fixture.scope.request.throughTurnNumber ?? 0) + 1,
          label,
          evaluationUuid(`memory:future:${index}`)
        ]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
    }
    if (fixture.id === "superseded-fact") {
      labelByMemoryId[replacementFact.rows[0]!.id] = fixture.expectedLabels[1]!;
      for (const label of fixture.forbiddenLabels?.supersededFact ?? []) {
        labelByMemoryId[replacedFact.rows[0]!.id] = label;
      }
    }
    const createDecoyCampaign = async (decoyOwnerUserId: string, decoyWorldVersionId?: string) => {
      const decoyVersionId = decoyWorldVersionId ?? (await database.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,2,$3::jsonb) RETURNING id`,
        [world.rows[0]!.id, decoyOwnerUserId, JSON.stringify({ world: { title: `${fixture.id} decoy` }, entities: [] })]
      )).rows[0]!.id;
      const decoyCampaign = await database.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
        [decoyOwnerUserId, decoyVersionId, `Chronicle evaluator decoy ${fixture.id}`]
      );
      await database.query("INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)", [decoyCampaign.rows[0]!.id, decoyOwnerUserId]);
      return { campaignId: decoyCampaign.rows[0]!.id, worldVersionId: decoyVersionId };
    };
    const insertDecoy = async (
      identityRole: string,
      label: string,
      decoyOwnerUserId: string,
      decoyCampaignId: string,
      decoyWorldVersionId: string,
      kind: "semantic" | "entity" | "lexical" = "lexical",
      memoryKind: "campaign_summary" | "open_thread" = "campaign_summary",
    ) => {
      const semanticColumns = kind === "semantic"
        ? ", embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions, embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint"
        : "";
      const semanticValues = kind === "semantic"
        ? ", '[1,0]'::vector, $5, 'fixture-embedding-v1', 2, $6, now(), 'fixture-embedding-fingerprint'"
        : "";
      const entities = kind === "entity" ? ["amber agreement"] : [];
      const content = kind === "semantic" ? "azure beacon confirmation" : "amber agreement scope anchor";
      const values: unknown[] = [decoyOwnerUserId, decoyCampaignId, decoyWorldVersionId, content];
      if (kind === "semantic") values.push(embeddingProviderId, chronicleContentHash(content));
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, entities${semanticColumns}, id)
         VALUES ($1,$2,$3,'${memoryKind}',1,$4,1,$${kind === "semantic" ? 7 : 5}::text[]${semanticValues},$${kind === "semantic" ? 8 : 6}) RETURNING id`,
        [...values, entities, evaluationUuid(identityRole)]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
    };
    const excluded = fixture.excludedLabels ?? {};
    for (const [index, label] of (excluded.owner ?? []).entries()) {
      const foreignUser = await database.query<{ id: string }>(
        "INSERT INTO users (display_name) VALUES ('Chronicle evaluator decoy owner') RETURNING id"
      );
      const foreignWorld = await database.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
        [foreignUser.rows[0]!.id, `Chronicle evaluator decoy ${fixture.id}`]
      );
      const foreignVersion = await database.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
        [foreignWorld.rows[0]!.id, foreignUser.rows[0]!.id, JSON.stringify({ world: { title: label }, entities: [] })]
      );
      const foreignCampaign = await database.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
        [foreignUser.rows[0]!.id, foreignVersion.rows[0]!.id, `Chronicle evaluator decoy ${fixture.id}`]
      );
      await database.query(
        "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
        [foreignCampaign.rows[0]!.id, foreignUser.rows[0]!.id]
      );
      await insertDecoy(`memory:excluded-owner:${index}`, label, foreignUser.rows[0]!.id, foreignCampaign.rows[0]!.id, foreignVersion.rows[0]!.id);
    }
    for (const [index, label] of (excluded.campaign ?? []).entries()) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(`memory:excluded-campaign:${index}`, label, ownerUserId, decoy.campaignId, decoy.worldVersionId);
    }
    for (const [index, label] of (excluded.worldVersion ?? []).entries()) {
      const decoyVersion = await database.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,2,$3::jsonb) RETURNING id`,
        [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: `${fixture.id} alternate version` }, entities: [] })]
      );
      await insertDecoy(`memory:excluded-world:${index}`, label, ownerUserId, campaign.rows[0]!.id, decoyVersion.rows[0]!.id, "lexical", "open_thread");
    }
    for (const [index, label] of (excluded.semantic ?? []).entries()) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(`memory:excluded-semantic:${index}`, label, ownerUserId, decoy.campaignId, decoy.worldVersionId, "semantic");
    }
    for (const [index, label] of (excluded.entity ?? []).entries()) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(`memory:excluded-entity:${index}`, label, ownerUserId, decoy.campaignId, decoy.worldVersionId, "entity");
    }
    // Authorized in-scope competition. These are legitimately retrievable and are neither
    // leakage nor decoys: they exist so the prompt has more plausible candidates than slots,
    // which is what makes recall@k and NDCG discriminate between calibration candidates.
    const distractorTurnBase = semantic ? 3 + (fixture.id === "location-alias" ? 5 : 6) : 3;
    for (let index = 0; index < (fixture.distractorCount ?? 0); index += 1) {
      const query = fixture.scope.request.query ?? fixture.id;
      const content = `${query} peripheral account ${index + 1}`;
      const turnNumber = distractorTurnBase + index;
      const turn = await database.query<{ id: string }>(
        `INSERT INTO turns (owner_user_id, campaign_id, turn_number, action, narration, state_snapshot_private)
         VALUES ($1,$2,$3,'Sanitized distractor action.','Sanitized distractor narration.','{}'::jsonb) RETURNING id`,
        [ownerUserId, campaign.rows[0]!.id, turnNumber]
      );
      await database.query(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, turn_id, memory_kind, ordinal, content, token_estimate,
            metadata, embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
            embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint, id)
         VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,1,'{}'::jsonb,$7::vector,$8,$9,$10,$11,
                 CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,$12,$13)`,
        [
          ownerUserId,
          campaign.rows[0]!.id,
          version.rows[0]!.id,
          turn.rows[0]!.id,
          turnNumber,
          content,
          semantic ? "[0,1]" : null,
          semantic ? embeddingProviderId : null,
          semantic ? "fixture-embedding-v1" : null,
          semantic ? 2 : null,
          semantic ? chronicleContentHash(content) : null,
          semantic ? "fixture-embedding-fingerprint" : null,
          evaluationUuid(`memory:distractor:${index}`)
        ]
      );
    }
    if (semantic || retrievalImplementation === "chunked_hybrid") {
      await database.query(
        `INSERT INTO campaign_memory_configs
           (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model,
            retrieval_implementation)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          campaign.rows[0]!.id,
          ownerUserId,
          semantic,
          embeddingProviderId,
          semantic ? "fixture-embedding-v1" : "",
          retrievalImplementation
        ]
      );
    }
    if (retrievalImplementation === "chunked_hybrid") {
      const parents = await database.query<Readonly<{
        id: string;
        memory_kind: "turn_fiction" | "legacy_summary" | "campaign_summary" | "canonical_fact" | "open_thread";
        content: string;
        content_hash: string;
        entities: readonly string[];
        entity_ids: readonly string[];
        metadata: Record<string, unknown>;
        embedding: string | null;
        embedding_provider_profile_id: string | null;
        embedding_model: string | null;
        embedding_dimensions: number | null;
        embedding_provider_fingerprint: string | null;
      }>>(
        `SELECT id,memory_kind,content,content_hash,entities,entity_ids,metadata,embedding::text,
                embedding_provider_profile_id,embedding_model,embedding_dimensions,embedding_provider_fingerprint
           FROM chronicle_memories
          WHERE owner_user_id=$1 AND campaign_id=$2 AND world_version_id=$3`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id]
      );
      for (const parent of parents.rows) {
        for (const chunk of chunkChronicleMemory({
          id: parent.id,
          memoryKind: parent.memory_kind,
          content: parent.content
        })) {
          const embedded = parent.embedding !== null;
          await database.query(
            `INSERT INTO chronicle_memory_chunks
               (id,owner_user_id,campaign_id,world_version_id,parent_memory_id,parent_content_hash,
                chunking_protocol_version,chunk_ordinal,chunk_kind,content,source_start_offset,
                source_end_offset,token_estimate,entities,entity_ids,metadata,embedding,embedding_status,
                embedding_skip_reason,embedding_provider_profile_id,embedding_model,embedding_dimensions,
                embedding_protocol_version,embedding_provider_fingerprint,embedding_content_hash,embedding_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text[],$15::text[],$16::jsonb,
                     $17::vector,$18,$19,$20,$21,$22,$23,$24,$25,
                     CASE WHEN $17::text IS NULL THEN NULL ELSE now() END)`,
            [
              deterministicChronicleEvaluationUuid(corpus.version, fixture.id, `chunk:${parent.id}:${chunk.chunkIndex}`),
              ownerUserId,
              campaign.rows[0]!.id,
              version.rows[0]!.id,
              parent.id,
              parent.content_hash,
              CHRONICLE_CHUNK_PROTOCOL_VERSION,
              chunk.chunkIndex,
              chunk.kind,
              chunk.content,
              chunk.sourceStartOffset,
              chunk.sourceEndOffset,
              chunk.estimatedTokens,
              [...parent.entities],
              [...parent.entity_ids],
              JSON.stringify(parent.metadata),
              parent.embedding,
              embedded ? "embedded" : "skipped",
              embedded ? null : "chunk_embedding_skipped",
              embedded ? parent.embedding_provider_profile_id : null,
              embedded ? parent.embedding_model : null,
              embedded ? parent.embedding_dimensions : null,
              embedded ? CHRONICLE_EMBEDDING_PROTOCOL_VERSION : null,
              embedded ? parent.embedding_provider_fingerprint : null,
              embedded ? chunk.contentHash : null
            ]
          );
        }
      }
    }
    cases.push({
      ...fixture,
      scope: {
        ...fixture.scope,
        ownerUserId,
        campaignId: campaign.rows[0]!.id,
        worldVersionId: version.rows[0]!.id
      },
      labelByMemoryId
    });
  }
  return { ...corpus, cases };
}

class EvaluationRollback<T> extends Error {
  constructor(readonly result: T) {
    super("Rollback deterministic Chronicle evaluation fixtures.");
  }
}

/**
 * The checked-in profile records the metrics it was selected on. Retrieval changes that land
 * after calibration silently invalidate those numbers, so the documented chunked verification
 * run re-measures them. Only deterministic metrics are compared; latency and request counts
 * are diagnostics that legitimately vary between runs.
 */
function assertProfileMetricsAreCurrent(
  report: Awaited<ReturnType<typeof evaluateChronicleRetrieval>>,
): void {
  if (report.corpusHash !== CHRONICLE_RETRIEVAL_PROFILE_V2.corpusHash) {
    throw new Error(
      "Chronicle retrieval profile was calibrated against a different corpus. Regenerate it with --calibrate."
    );
  }
  const recorded = CHRONICLE_RETRIEVAL_PROFILE_V2.metrics;
  const measured = report.metrics;
  const drifted = ([
    ["recallAt5", recorded.recallAt5, measured.recallAt5],
    ["recallAt10", recorded.recallAt10, measured.recallAt10],
    ["recallAt20", recorded.recallAt20, measured.recallAt20],
    ["mrr", recorded.mrr, measured.mrr],
    ["ndcg", recorded.ndcg, measured.ndcg],
    ["duplicateRate", recorded.duplicateRate, measured.duplicateRate]
  ] as const).filter(([, expected, actual]) => Math.abs(expected - actual) > 1e-9);
  if (drifted.length) {
    throw new Error(
      `Chronicle retrieval profile metrics are stale: ${
        drifted.map(([name, expected, actual]) => `${name} recorded ${expected}, measured ${actual}`).join("; ")
      }. Regenerate the profile with --calibrate.`
    );
  }
}

function assertCorpusResultInvariants(report: Awaited<ReturnType<typeof evaluateChronicleRetrieval>>): void {
  const supersededFact = report.cases.find((result) => result.id === "superseded-fact");
  const canonicalReplacementLabel = "superseded-fact-canonical-replacement";
  if (!supersededFact || supersededFact.ranks[canonicalReplacementLabel] === null) {
    throw new Error("Chronicle evaluation did not retrieve the canonical replacement fact.");
  }
  if (supersededFact.retrievedLabels.filter((label) => label === canonicalReplacementLabel).length !== 1) {
    throw new Error("Chronicle evaluation retrieved an ambiguous canonical replacement label.");
  }
}

const corpusArgument = argument("--corpus");
const corpus = await loadCorpus(resolveRepositoryCorpusPath(corpusArgument));
const explicitDiagnosticCorpus = corpusArgument !== undefined;
const corpusHash = chronicleRetrievalCorpusHash(corpus);
const calibrate = process.argv.includes("--calibrate");
const baselineArgument = argument("--baseline");
const profileArgument = argument("--write-profile");
if (calibrate && (!baselineArgument || !profileArgument)) {
  throw new Error("Chronicle calibration requires both --baseline and --write-profile.");
}
const output = resolve(root, argument("--output") ?? defaultOutput);
const implementation = argument("--implementation") ?? "legacy_hybrid";
let baseline: ChronicleEvaluationReport | undefined;
if (calibrate) {
  baseline = JSON.parse(await readFile(resolve(root, baselineArgument!), "utf8")) as ChronicleEvaluationReport;
  if (baseline.implementation !== "legacy_hybrid" || baseline.corpusHash !== corpusHash) {
    throw new Error("Chronicle calibration baseline does not match the current fixture corpus.");
  }
}
const databaseConfig = process.env.TEST_DATABASE_URL
  ? { databaseUrl: process.env.TEST_DATABASE_URL }
  : await ensureTestDatabase({ projectRoot: root });
const pool = createDatabasePool(databaseConfig.databaseUrl, 4);
await migrateDatabase(pool, resolve(root, "database/migrations"));
const ownerUserId = await initialOwnerId(pool);
let result: ChronicleEvaluationReport | ChronicleRetrievalProfileV2;
try {
  await withTransaction(pool, async (database) => {
    const seededCorpus = await seedCorpus(
      database,
      ownerUserId,
      corpus,
      calibrate ? "chunked_hybrid" : implementation === "chunked_hybrid" ? "chunked_hybrid" : "legacy_hybrid"
    );
    if (calibrate) {
      const profile = await calibrateChronicleRetrievalProfile({
        corpusHash,
        baselineMetrics: baseline!.metrics,
        async evaluate(parameters) {
          const evaluated = await evaluateChronicleRetrieval(
            retrievalApplication(chronicleProductionRankFusionProfile(parameters)),
            database,
            seededCorpus,
            { implementation: "chunked_hybrid", corpusHash }
          );
          assertCorpusResultInvariants(evaluated);
          return evaluated.metrics;
        }
      });
      throw new EvaluationRollback(profile);
    }
    const evaluated = await evaluateChronicleRetrieval(
      retrievalApplication(),
      database,
      seededCorpus,
      { implementation, corpusHash }
    );
    assertCorpusResultInvariants(evaluated);
    if (implementation === "chunked_hybrid" && !explicitDiagnosticCorpus) assertProfileMetricsAreCurrent(evaluated);
    throw new EvaluationRollback(evaluated);
  });
  throw new Error("Chronicle evaluation fixtures did not roll back.");
} catch (error) {
  if (!(error instanceof EvaluationRollback)) throw error;
  result = error.result as ChronicleEvaluationReport | ChronicleRetrievalProfileV2;
} finally {
  await pool.end();
}
if (calibrate) {
  const profileOutput = resolve(root, profileArgument!);
  await mkdir(dirname(profileOutput), { recursive: true });
  await writeFile(profileOutput, renderChronicleRetrievalProfileModule(result as ChronicleRetrievalProfileV2), "utf8");
  process.stdout.write(`${profileOutput}\n`);
} else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}
