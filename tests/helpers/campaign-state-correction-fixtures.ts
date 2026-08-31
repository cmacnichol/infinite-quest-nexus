import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { storyImportRequestSchema } from "../../packages/contracts/src/imports.js";
import { initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import {
  getCampaignRuntimeState,
  importLegacyStory,
} from "./memory-aware-services.js";

export async function createCorrectionFixture(pool: DatabasePool) {
  const story = JSON.parse(await readFile(resolve("tests/fixtures/legacy-story.json"), "utf8"));
  story.world.title = "Current correction " + crypto.randomUUID();
  const imported = await importLegacyStory(pool, storyImportRequestSchema.parse({
    sourceName: "current-correction.story",
    story,
  }));
  const before = await getCampaignRuntimeState(pool, imported.campaignId);
  return {
    campaignId: imported.campaignId,
    ownerUserId: await initialOwnerId(pool),
    before,
  };
}

export async function snapshotCorrectionEvidence(pool: DatabasePool, campaignId: string) {
  const tables = [
    "turns", "campaign_state", "campaign_state_edits",
    "campaign_canonical_facts", "chronicle_memories",
    "chronicle_memory_chunks", "chronicle_jobs", "chronicle_chunk_jobs",
    "model_chains", "summary_checkpoints",
  ] as const;
  const entries = await Promise.all(tables.map(async (table) => {
    const result = await pool.query(
      "SELECT to_jsonb(t) AS value FROM " + table +
      " t WHERE campaign_id=$1 ORDER BY to_jsonb(t)::text",
      [campaignId],
    );
    return [table, result.rows.map((row) => row.value)] as const;
  }));
  return Object.fromEntries(entries);
}
