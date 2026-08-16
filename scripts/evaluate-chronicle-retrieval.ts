import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresChronicleGenerationTransactionPort } from "../packages/database/src/chronicle-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabaseClient } from "../packages/database/src/pool.js";
import { migrateDatabase } from "../packages/database/src/migrate.js";
import { chronicleContentHash } from "../packages/domain/src/chronicle-memory-helpers.js";
import { ensureTestDatabase } from "./ensure-test-database.mjs";
import {
  evaluateChronicleRetrieval,
  type ChronicleRetrievalApplication,
  type ChronicleRetrievalCorpus
} from "./lib/chronicle-retrieval-evaluator.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = "tmp/chronicle-evaluation/legacy-baseline.json";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadCorpus(): Promise<ChronicleRetrievalCorpus> {
  return JSON.parse(await readFile(resolve(root, "tests/fixtures/chronicle-retrieval-evaluation.v1.json"), "utf8")) as ChronicleRetrievalCorpus;
}

function legacyApplication(): ChronicleRetrievalApplication {
  const vectorFor = (text: string): readonly number[] => (
    text.includes("amber agreement") ? [1, 0] : [0, 1]
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
      embeddings: {
        async resolve(_database, scope) { return scope.selectedProviderProfileId ?? null; },
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

async function seedCorpus(database: DatabaseClient, ownerUserId: string, corpus: ChronicleRetrievalCorpus): Promise<ChronicleRetrievalCorpus> {
  const cases: ChronicleRetrievalCorpus["cases"][number][] = [];
  for (const fixture of corpus.cases) {
    const semantic = fixture.id === "paraphrase" || fixture.id === "character-alias" || fixture.id === "location-alias";
    const world = await database.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
      [ownerUserId, `Chronicle evaluator ${fixture.id}`]
    );
    const version = await database.query<{ id: string }>(
      `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [world.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: fixture.id }, entities: [] })]
    );
    const campaign = await database.query<{ id: string }>(
      "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
      [ownerUserId, version.rows[0]!.id, `Chronicle evaluator ${fixture.id}`]
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
      [randomUUID(), ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, firstTurn.rows[0]!.id]
    );
    const replacementFact = await database.query<{ id: string }>(
      `INSERT INTO campaign_canonical_facts
         (id, owner_user_id, campaign_id, world_version_id, source_turn_id, source_turn_number, source_fact_index,
          content, normalized_content, valid_from_turn)
       VALUES ($1,$2,$3,$4,$5,2,0,'Sanitized replacement fact.','sanitized replacement fact.',2) RETURNING id`,
      [randomUUID(), ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, secondTurn.rows[0]!.id]
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
      await database.query(
        `INSERT INTO campaign_memory_configs
           (campaign_id, owner_user_id, embedding_enabled, embedding_provider_profile_id, embedding_model)
         VALUES ($1,$2,true,$3,'fixture-embedding-v1')`,
        [campaign.rows[0]!.id, ownerUserId, embeddingProviderId]
      );
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
              embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
           VALUES ($1,$2,$3,$4,'turn_fiction',$5,$6,1,'[0,1]'::vector,$7,'fixture-embedding-v1',2,$8,now(),'fixture-embedding-fingerprint')
           RETURNING id`,
          [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, turn.rows[0]!.id, index + 2, content, embeddingProviderId, chronicleContentHash(content)]
        );
        labelByMemoryId[decoy.rows[0]!.id] = `semantic-lexical-decoy-${index + 1}`;
      }
    }
    for (const [index, label] of fixture.expectedLabels.entries()) {
      const content = semantic ? "azure beacon confirmation" : `sanitized record ${fixture.id} ${index + 1}`;
      const ordinal = semantic ? index + 32 : index + 1;
      const memory = semantic
        ? await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate,
            embedding, embedding_provider_profile_id, embedding_model, embedding_dimensions,
            embedding_content_hash, embedding_updated_at, embedding_provider_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7::vector,$8,$9,$10,$11,now(),$12) RETURNING id`,
        [
          ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, index === 0 ? "campaign_summary" : "canonical_fact", ordinal,
          content, "[1,0]", embeddingProviderId, "fixture-embedding-v1", 2, chronicleContentHash(content), "fixture-embedding-fingerprint"
        ]
      )
        : await database.query<{ id: string }>(
          `INSERT INTO chronicle_memories
             (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
           VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id`,
          [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, index === 0 ? "campaign_summary" : "canonical_fact", ordinal, content]
        );
      labelByMemoryId[memory.rows[0]!.id] = label;
    }
    for (const label of fixture.forbiddenLabels?.futureTurn ?? []) {
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
         VALUES ($1,$2,$3,'canonical_fact',$4,$5,1) RETURNING id`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, (fixture.scope.request.throughTurnNumber ?? 0) + 1, label]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
    }
    if (fixture.id === "superseded-fact") {
      labelByMemoryId[replacementFact.rows[0]!.id] = fixture.expectedLabels[0]!;
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
    const insertDecoy = async (label: string, decoyOwnerUserId: string, decoyCampaignId: string, decoyWorldVersionId: string, kind: "semantic" | "entity" | "lexical" = "lexical") => {
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
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate, entities${semanticColumns})
         VALUES ($1,$2,$3,'campaign_summary',1,$4,1,$${kind === "semantic" ? 7 : 5}::text[]${semanticValues}) RETURNING id`,
        [...values, entities]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
    };
    const excluded = fixture.excludedLabels ?? {};
    for (const label of excluded.owner ?? []) {
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
      await insertDecoy(label, foreignUser.rows[0]!.id, foreignCampaign.rows[0]!.id, foreignVersion.rows[0]!.id);
    }
    for (const label of excluded.campaign ?? []) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(label, ownerUserId, decoy.campaignId, decoy.worldVersionId);
    }
    for (const label of excluded.worldVersion ?? []) {
      const decoy = await createDecoyCampaign(ownerUserId);
      await insertDecoy(label, ownerUserId, decoy.campaignId, decoy.worldVersionId);
    }
    for (const label of excluded.semantic ?? []) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(label, ownerUserId, decoy.campaignId, decoy.worldVersionId, "semantic");
    }
    for (const label of excluded.entity ?? []) {
      const decoy = await createDecoyCampaign(ownerUserId, version.rows[0]!.id);
      await insertDecoy(label, ownerUserId, decoy.campaignId, decoy.worldVersionId, "entity");
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

class EvaluationRollback extends Error {
  constructor(readonly report: Awaited<ReturnType<typeof evaluateChronicleRetrieval>>) {
    super("Rollback deterministic Chronicle evaluation fixtures.");
  }
}

const corpus = await loadCorpus();
const output = resolve(root, argument("--output") ?? defaultOutput);
const implementation = argument("--implementation") ?? "legacy_hybrid";
const databaseConfig = await ensureTestDatabase({ projectRoot: root });
const pool = createDatabasePool(databaseConfig.databaseUrl, 4);
await migrateDatabase(pool, resolve(root, "database/migrations"));
const ownerUserId = await initialOwnerId(pool);
let report: Awaited<ReturnType<typeof evaluateChronicleRetrieval>>;
try {
  await withTransaction(pool, async (database) => {
    const seededCorpus = await seedCorpus(database, ownerUserId, corpus);
    throw new EvaluationRollback(await evaluateChronicleRetrieval(legacyApplication(), database, seededCorpus, { implementation }));
  });
  throw new Error("Chronicle evaluation fixtures did not roll back.");
} catch (error) {
  if (!(error instanceof EvaluationRollback)) throw error;
  report = error.report;
} finally {
  await pool.end();
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${output}\n`);
