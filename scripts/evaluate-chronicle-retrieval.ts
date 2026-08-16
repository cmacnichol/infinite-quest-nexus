import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresChronicleGenerationTransactionPort } from "../packages/database/src/chronicle-repository.js";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabaseClient } from "../packages/database/src/pool.js";
import { migrateDatabase } from "../packages/database/src/migrate.js";
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
  return {
    generation: createPostgresChronicleGenerationTransactionPort({ embeddings: {} as never })
  };
}

async function seedCorpus(database: DatabaseClient, ownerUserId: string, corpus: ChronicleRetrievalCorpus): Promise<ChronicleRetrievalCorpus> {
  const cases: ChronicleRetrievalCorpus["cases"][number][] = [];
  for (const fixture of corpus.cases) {
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
    const labelByMemoryId: Record<string, string> = {};
    for (const [index, label] of fixture.expectedLabels.entries()) {
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
         VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, index === 0 ? "campaign_summary" : "canonical_fact", index + 1, label]
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
    for (const label of fixture.forbiddenLabels?.supersededFact ?? []) {
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
         VALUES ($1,$2,$3,'legacy_summary',1,$4,1) RETURNING id`,
        [ownerUserId, campaign.rows[0]!.id, version.rows[0]!.id, label]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
    }
    for (const label of fixture.forbiddenLabels?.crossCampaign ?? []) {
      const foreignWorld = await database.query<{ id: string }>(
        "INSERT INTO worlds (owner_user_id, title) VALUES ($1,$2) RETURNING id",
        [ownerUserId, `Chronicle evaluator decoy ${fixture.id}`]
      );
      const foreignVersion = await database.query<{ id: string }>(
        `INSERT INTO world_versions (world_id, owner_user_id, version_number, content)
         VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
        [foreignWorld.rows[0]!.id, ownerUserId, JSON.stringify({ world: { title: label }, entities: [] })]
      );
      const foreignCampaign = await database.query<{ id: string }>(
        "INSERT INTO campaigns (owner_user_id, world_version_id, title) VALUES ($1,$2,$3) RETURNING id",
        [ownerUserId, foreignVersion.rows[0]!.id, `Chronicle evaluator decoy ${fixture.id}`]
      );
      await database.query(
        "INSERT INTO campaign_state (campaign_id, owner_user_id) VALUES ($1,$2)",
        [foreignCampaign.rows[0]!.id, ownerUserId]
      );
      const memory = await database.query<{ id: string }>(
        `INSERT INTO chronicle_memories
           (owner_user_id, campaign_id, world_version_id, memory_kind, ordinal, content, token_estimate)
         VALUES ($1,$2,$3,'campaign_summary',1,$4,1) RETURNING id`,
        [ownerUserId, foreignCampaign.rows[0]!.id, foreignVersion.rows[0]!.id, label]
      );
      labelByMemoryId[memory.rows[0]!.id] = label;
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
