import type { MemoryApplication } from "../../../packages/application/src/memory/index.js";
import { chronicleHealthSchema, type MemoryContextQuery } from "../../../packages/contracts/src/memory.js";
import type { DatabasePool } from "../../../packages/database/src/pool.js";

export type MemoryApplicationAdapter = Readonly<{
  metrics(ownerUserId: string, campaignId: string): Promise<Record<string, unknown>>;
  contextPreview(ownerUserId: string, campaignId: string, request: MemoryContextQuery): Promise<Record<string, unknown>>;
  reindex(ownerUserId: string, campaignId: string): Promise<Readonly<{ jobId: string; status: "queued" }>>;
  embeddingConfig(ownerUserId: string, campaignId: string): Promise<Record<string, unknown>>;
  setEmbeddingConfig(ownerUserId: string, campaignId: string, input: Parameters<MemoryApplication["setEmbeddingConfig"]>[1]): Promise<Record<string, unknown>>;
  reindexEmbeddings(ownerUserId: string, campaignId: string): Promise<string | null>;
  job(ownerUserId: string, jobId: string): ReturnType<MemoryApplication["getJob"]>;
}>;

async function campaignScope(pool: DatabasePool, ownerUserId: string, campaignId: string) {
  const result = await pool.query<{ world_version_id: string }>(
    "SELECT world_version_id FROM campaigns WHERE id = $1 AND owner_user_id = $2",
    [campaignId, ownerUserId]
  );
  const worldVersionId = result.rows[0]?.world_version_id;
  if (!worldVersionId) throw Object.assign(new Error("Campaign not found."), { statusCode: 404 });
  return { ownerUserId, campaignId, worldVersionId };
}

/** HTTP mapping stays thin: owner authority is resolved by Fastify and every
 * repository call remains explicitly campaign/world-version scoped. */
export function createMemoryApplicationAdapter(
  pool: DatabasePool,
  application: MemoryApplication,
): MemoryApplicationAdapter {
  return {
    async metrics(ownerUserId, campaignId) {
      const metrics = await application.getMetrics(await campaignScope(pool, ownerUserId, campaignId));
      if ("failure" in metrics) return metrics;
      return { ...metrics, semanticHealth: chronicleHealthSchema.parse(metrics.semanticHealth) };
    },
    async contextPreview(ownerUserId, campaignId, request) {
      const scope = await campaignScope(pool, ownerUserId, campaignId);
      return application.previewContext(scope, request) as Promise<Record<string, unknown>>;
    },
    async reindex(ownerUserId, campaignId) {
      return application.enqueueChronicleReindex(await campaignScope(pool, ownerUserId, campaignId));
    },
    async embeddingConfig(ownerUserId, campaignId) {
      return application.getEmbeddingConfig(await campaignScope(pool, ownerUserId, campaignId));
    },
    async setEmbeddingConfig(ownerUserId, campaignId, input) {
      return application.setEmbeddingConfig(await campaignScope(pool, ownerUserId, campaignId), input);
    },
    async reindexEmbeddings(ownerUserId, campaignId) {
      const result = await application.enqueueEmbeddingReindex(await campaignScope(pool, ownerUserId, campaignId));
      return result?.jobId ?? null;
    },
    job: (ownerUserId, jobId) => application.getJob({ ownerUserId, jobId })
  };
}
