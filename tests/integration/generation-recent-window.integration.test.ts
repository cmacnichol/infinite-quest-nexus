import { branchCampaign } from "../helpers/memory-aware-services.js";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabasePool, initialOwnerId, withTransaction, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { resolveGenerationAuthoritySnapshot } from "../../packages/database/src/generation-authority.js";
import { loadPostgresChronicleGenerationAuthorityContext } from "../../packages/database/src/chronicle-generation-context.js";
import { sha256 } from "../../packages/domain/src/text.js";

const integration = process.env.TEST_DATABASE_URL ? describe.sequential : describe.skip;
integration("direct recent effective turn window", () => {
  let pool: DatabasePool;
  let ownerUserId: string;
  beforeAll(async () => { pool = createDatabasePool(process.env.TEST_DATABASE_URL!, 4); await migrateDatabase(pool, resolve("database/migrations")); ownerUserId = await initialOwnerId(pool); });
  afterEach(async () => { await pool.query("DELETE FROM campaigns"); await pool.query("DELETE FROM world_versions"); await pool.query("DELETE FROM worlds"); });
  afterAll(async () => { await pool?.end(); });
  async function fixture(turns: number) {
    const world = await pool.query<{ id: string }>("INSERT INTO worlds(owner_user_id,title) VALUES($1,'Recent test') RETURNING id", [ownerUserId]);
    const version = await pool.query<{ id: string }>("INSERT INTO world_versions(owner_user_id,world_id,version_number,content) VALUES($1,$2,1,'{}') RETURNING id", [ownerUserId, world.rows[0]!.id]);
    const campaign = await pool.query<{ id: string }>("INSERT INTO campaigns(owner_user_id,world_version_id,title,active_turn_number,character_snapshot) VALUES($1,$2,'Recent test',$3,'{}') RETURNING id", [ownerUserId, version.rows[0]!.id, turns]);
    const scope = { ownerUserId, campaignId: campaign.rows[0]!.id, worldVersionId: version.rows[0]!.id };
    await pool.query("INSERT INTO campaign_state(owner_user_id,campaign_id) VALUES($1,$2)", [ownerUserId, scope.campaignId]);
    for (let ordinal = 1; ordinal <= turns; ordinal++) await pool.query(
      "INSERT INTO turns(owner_user_id,campaign_id,turn_number,action,narration,input_mode,state_snapshot_private) VALUES($1,$2,$3,$4,$5,$6,'{}')",
      [ownerUserId, scope.campaignId, ordinal, `Intent ${ordinal}.`, `Accepted narration ${ordinal}.`, ordinal % 2 ? "action" : "scene"]);
    return scope;
  }
  async function capture(scope: Awaited<ReturnType<typeof fixture>>, expectedTurnNumber: number, operationKind: "append" | "replace_latest" = "append") {
    return withTransaction(pool, async (client) => {
      const input = { ...scope, expectedTurnNumber, operationKind, query: "Continue." };
      const frozen = await resolveGenerationAuthoritySnapshot(client, { ...input, baseIdentityVersion: "generation-base-v3", captureRecentWindow: true });
      const context = await loadPostgresChronicleGenerationAuthorityContext(client, { ...input, expectedBaseIdentity: frozen.baseIdentity });
      return { frozen, context, input };
    });
  }
  it.each([0, 1, 2, 5])("captures preceding exact ordinals with %s accepted turns and no Chronicle", async (turns) => {
    const scope = await fixture(turns);
    const { context } = await capture(scope, turns + 1);
    expect(context.recentTurns?.map((turn) => turn.turnNumber)).toEqual(Array.from({ length: Math.min(2, Math.max(0, turns - 1)) }, (_, index) => Math.max(1, turns - 2) + index));
    expect(context.candidates).toEqual([]);
    if (turns) expect(context.authority.latestTurn?.inputMode).toBe(turns % 2 ? "action" : "scene");
    for (const turn of context.recentTurns ?? []) { expect(turn.action).toBe(`Intent ${turn.turnNumber}.`); expect(turn.narration).toBe(`Accepted narration ${turn.turnNumber}.`); }
  });
  it("excludes the replaced turn, keeps gaps explicit, and preserves complete huge predecessors", async () => {
    const scope = await fixture(5);
    const huge = "The lantern burns beside the bridge. ".repeat(1000);
    await pool.query("UPDATE turns SET narration=$3 WHERE campaign_id=$1 AND turn_number=$2", [scope.campaignId, 3, huge]);
    const replacement = await capture(scope, 5, "replace_latest");
    expect(replacement.context.recentTurns?.map((turn) => turn.turnNumber)).toEqual([2, 3]);
    expect(replacement.context.recentTurns?.[1]?.narration).toBe(huge.trim());
    await pool.query("DELETE FROM turns WHERE campaign_id=$1 AND turn_number=3", [scope.campaignId]);
    expect((await capture(scope, 5, "replace_latest")).context.recentTurns?.map((turn) => turn.turnNumber)).toEqual([2]);
  });
  it("uses branch-owned source identities and leaves R1 and legacy captures unchanged", async () => {
    const scope = await fixture(5);
    const source = await capture(scope, 6);
    const branch = await branchCampaign(pool, scope.campaignId, { targetTurnNumber: 4, expectedCurrentTurnNumber: 5 });
    const branched = await capture({ ...scope, campaignId: branch.id }, 5);
    expect(branched.context.recentTurns?.map((turn) => turn.turnNumber)).toEqual([2, 3]);
    expect(branched.context.recentTurns?.every((turn) => !source.context.recentTurns?.some((original) => original.turnId === turn.turnId))).toBe(true);
    for (const baseIdentityVersion of ["legacy", "generation-base-v3"] as const) {
      const frozen = await withTransaction(pool, (client) => resolveGenerationAuthoritySnapshot(client, { ...source.input, baseIdentityVersion }));
      expect(frozen).not.toHaveProperty("recentTurns");
      expect(frozen.baseIdentity).not.toHaveProperty("recentWindowFingerprint");
      const context = await withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client,
        { ...source.input, expectedBaseIdentity: frozen.baseIdentity }));
      if (baseIdentityVersion === "legacy") expect(context.authority.latestTurn).not.toHaveProperty("inputMode");
      else expect(context.authority.latestTurn?.inputMode).toBe("action");
    }
  });

  it("binds corrected predecessor revisions and source hashes to the frozen authority", async () => {
    const scope = await fixture(4);
    const before = await capture(scope, 5);
    const predecessor = await pool.query<{ id: string; narration: string }>("SELECT id,narration FROM turns WHERE campaign_id=$1 AND turn_number=3", [scope.campaignId]);
    await pool.query(`INSERT INTO turn_narration_corrections(owner_user_id,campaign_id,turn_id,revision,narration,previous_effective_narration_hash,reason,source,created_by_user_id)
      VALUES($1,$2,$3,1,'A corrected predecessor.', $4,'Test','administrative',$1)`, [ownerUserId, scope.campaignId, predecessor.rows[0]!.id, sha256(predecessor.rows[0]!.narration)]);
    const after = await capture(scope, 5);
    expect(after.frozen.baseIdentity).not.toEqual(before.frozen.baseIdentity);
    expect(after.context.recentTurns?.[1]).toMatchObject({ narration: "A corrected predecessor.", narrationCorrectionRevision: 1 });
    await expect(withTransaction(pool, (client) => loadPostgresChronicleGenerationAuthorityContext(client, { ...before.input, expectedBaseIdentity: before.frozen.baseIdentity }))).rejects.toMatchObject({ code: "authoritative_context_invalid" });
  });
});
