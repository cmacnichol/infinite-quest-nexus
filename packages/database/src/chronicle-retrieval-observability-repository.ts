import {
  chronicleRetrievalRunSchema,
  type ChronicleRetrievalComparison,
  type ChronicleRetrievalRun
} from "../../contracts/src/memory.js";
import { withTransaction, type DatabaseClient, type DatabasePool } from "./pool.js";

const SAVEPOINT = "chronicle_retrieval_observability_write";

function comparison(
  comparisons: readonly ChronicleRetrievalComparison[],
  implementation: ChronicleRetrievalComparison["implementation"],
): ChronicleRetrievalComparison | undefined {
  return comparisons.find((candidate) => candidate.implementation === implementation);
}

async function writeRetrievalComparison(client: DatabaseClient, run: ChronicleRetrievalRun): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    [`chronicle-retrieval-observability:${run.ownerUserId}:${run.campaignId}`]
  );
  const lexical = comparison(run.comparisons, "lexical");
  const legacy = comparison(run.comparisons, "legacy_hybrid");
  const chunked = comparison(run.comparisons, "chunked_hybrid");
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO chronicle_retrieval_runs (
       owner_user_id,campaign_id,world_version_id,query_hash,production_implementation,shadow_enabled,
       retrieval_version,embedding_protocol_version,chunk_protocol_version,provider_fingerprint,
       query_token_estimate,cost_ids,lexical_latency_ms,lexical_fallback_code,
       legacy_hybrid_latency_ms,legacy_hybrid_fallback_code,
       chunked_hybrid_latency_ms,chunked_hybrid_fallback_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid[],$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [
      run.ownerUserId,
      run.campaignId,
      run.worldVersionId,
      run.queryHash,
      run.productionImplementation,
      run.shadowEnabled,
      run.retrievalVersion,
      run.embeddingProtocolVersion,
      run.chunkProtocolVersion,
      run.providerFingerprint,
      run.queryTokenEstimate,
      run.costIds,
      lexical?.latencyMs ?? null,
      lexical?.fallbackCode ?? null,
      legacy?.latencyMs ?? null,
      legacy?.fallbackCode ?? null,
      chunked?.latencyMs ?? null,
      chunked?.fallbackCode ?? null
    ]
  );
  const runId = inserted.rows[0]!.id;
  const candidates = run.comparisons.flatMap((compared) => compared.candidates.map((candidate) => ({
    implementation: compared.implementation,
    candidate_id: candidate.candidateId,
    parent_memory_id: candidate.parentMemoryId,
    rank: candidate.rank,
    reason: candidate.reason,
    token_estimate: candidate.tokenEstimate,
    selected: candidate.selected,
    production_selection: compared.selectedForProduction && candidate.selected
  })));
  if (candidates.length) {
    await client.query(
      `INSERT INTO chronicle_retrieval_candidates (
         run_id,owner_user_id,campaign_id,world_version_id,implementation,candidate_id,parent_memory_id,
         rank,reason,token_estimate,selected,production_selection
       )
       SELECT $1,$2,$3,$4,candidate.implementation,candidate.candidate_id,candidate.parent_memory_id,
              candidate.rank,candidate.reason,candidate.token_estimate,candidate.selected,candidate.production_selection
         FROM jsonb_to_recordset($5::jsonb) AS candidate(
           implementation text,candidate_id text,parent_memory_id uuid,rank integer,reason text,
           token_estimate integer,selected boolean,production_selection boolean
         )`,
      [runId, run.ownerUserId, run.campaignId, run.worldVersionId, JSON.stringify(candidates)]
    );
  }
  await client.query(
    `DELETE FROM chronicle_retrieval_runs
      WHERE campaign_id = $1 AND owner_user_id = $2
        AND created_at < clock_timestamp() - interval '30 days'`,
    [run.campaignId, run.ownerUserId]
  );
  await client.query(
    `DELETE FROM chronicle_retrieval_runs
      WHERE id IN (
        SELECT id FROM chronicle_retrieval_runs
         WHERE campaign_id = $1 AND owner_user_id = $2
         ORDER BY created_at DESC,id DESC
         OFFSET 5000
      )`,
    [run.campaignId, run.ownerUserId]
  );
}

async function writeWithinCallerTransaction(client: DatabaseClient, run: ChronicleRetrievalRun): Promise<void> {
  await client.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    await writeRetrievalComparison(client, run);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    throw error;
  }
}

/**
 * Persists only the strict safe metadata contract. Callers own best-effort
 * logging so the fixed diagnostic can use their existing structured logger.
 */
export async function recordRetrievalComparison(
  database: DatabasePool | DatabaseClient,
  input: unknown,
): Promise<void> {
  const run = chronicleRetrievalRunSchema.parse(input);
  if ("totalCount" in database) {
    await withTransaction(database as DatabasePool, (client) => writeRetrievalComparison(client, run));
    return;
  }
  await writeWithinCallerTransaction(database, run);
}
