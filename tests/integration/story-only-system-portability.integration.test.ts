import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_ARCHIVE_DOMAINS, systemRecordEnvelopeSchema, type SystemRecordEnvelope } from "../../packages/contracts/src/system-archives.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { createPostgresSystemArchiveExportRepository } from "../../packages/database/src/system-archive-export-repository.js";
import { createPostgresSystemArchiveImportRepository } from "../../packages/database/src/system-archive-import-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe.sequential : describe.skip;
type SystemV3CampaignEnvelope = Extract<SystemRecordEnvelope, { domain: "campaigns"; formatVersion: 3 }>;
type SystemV3TurnEnvelope = Extract<SystemRecordEnvelope, { domain: "turns"; formatVersion: 3 }>;

const runtimePolicy = {
  version: 1,
  playMode: "story_only",
  turnControlStyle: "flexible_scene",
  protocolVersion: "story-only-v1",
  prompts: {
    systemSupplement: "private system prompt",
    systemSupplementHash: "a".repeat(64),
    choiceRepairSystem: "private repair prompt",
    choiceRepairSystemHash: "b".repeat(64),
  },
};
const externalRuntimePolicySnapshot = {
  ...runtimePolicy,
  prompts: {
    systemSupplement: "EXTERNAL_RUNTIME_SYSTEM_SENTINEL",
    systemSupplementHash: "c".repeat(64),
    choiceRepairSystem: "EXTERNAL_RUNTIME_REPAIR_SENTINEL",
    choiceRepairSystemHash: "d".repeat(64),
  },
};

async function exportedRecords(pool: DatabasePool, ownerUserId: string): Promise<SystemRecordEnvelope[]> {
  const exporter = createPostgresSystemArchiveExportRepository(pool, {
    pageSize: 10,
    sourceApplicationVersion: "0.1.0",
  });
  return exporter.withOwnerSnapshot({ ownerUserId }, async (snapshot) => {
    const records: SystemRecordEnvelope[] = [];
    for (const domain of SYSTEM_ARCHIVE_DOMAINS) {
      for await (const record of snapshot.streamDomain(domain)) records.push(record);
    }
    return records;
  });
}

integration("story-only System Archive PostgreSQL portability", () => {
  let pool: DatabasePool;
  let destinationOwnerUserId: string;

  beforeAll(async () => {
    const isolated = new URL(databaseUrl!);
    expect(
      (isolated.hostname === "127.0.0.1" && isolated.port === "15439")
      || (isolated.hostname === "infinitequest-story-only-test" && isolated.port === "5432"),
    ).toBe(true);
    expect(isolated.pathname).toMatch(/^\/infinitequest_test_[a-f0-9]{32}$/u);
    pool = createDatabasePool(databaseUrl!, 4);
    await expect(pool.query<{ name: string }>("SELECT current_database() AS name"))
      .resolves.toMatchObject({ rows: [{ name: isolated.pathname.slice(1) }] });
    await migrateDatabase(pool, resolve("database/migrations"));
    destinationOwnerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => { await pool?.end(); });

  it("remaps story-only ownership and preserves portable policy, raw dormant state, and historical nulls", async () => {
    const sourceOwnerUserId = (await pool.query<{ id: string }>(
      "INSERT INTO users (display_name,status) VALUES ($1,'active') RETURNING id",
      [`System story-only source ${randomUUID()}`],
    )).rows[0]!.id;
    const worldId = (await pool.query<{ id: string }>(
      "INSERT INTO worlds (owner_user_id,title) VALUES ($1,$2) RETURNING id",
      [sourceOwnerUserId, `System policy world ${randomUUID()}`],
    )).rows[0]!.id;
    const worldVersionId = (await pool.query<{ id: string }>(
      `INSERT INTO world_versions (world_id,owner_user_id,version_number,content)
       VALUES ($1,$2,1,$3::jsonb) RETURNING id`,
      [worldId, sourceOwnerUserId, JSON.stringify({ schemaVersion: 4, world: { title: "System policy world" } })],
    )).rows[0]!.id;
    const campaignId = (await pool.query<{ id: string }>(
      `INSERT INTO campaigns (owner_user_id,world_version_id,title,active_turn_number,turn_control_style)
       VALUES ($1,$2,'System story-only campaign',2,'flexible_scene') RETURNING id`,
      [sourceOwnerUserId, worldVersionId],
    )).rows[0]!.id;
    const dormantStats = [{ name: "Courage", value: 7, nested: { untouched: true } }];
    const dormantPendingEvents = [{
      id: "pending-sealed-gate",
      sourceTriggerId: "sealed-gate",
      name: "The sealed gate",
      timing: "after",
      condition: "The oath is remembered.",
      effect: "The gate stirs.",
      instructions: "Keep this event dormant in Story Direction.",
      reason: "Imported pending event",
      sourceTurn: 1,
    }];
    await pool.query(
      `INSERT INTO campaign_state (campaign_id,owner_user_id,rpg_stats,pending_event_triggers)
       VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
      [campaignId, sourceOwnerUserId, JSON.stringify(dormantStats), JSON.stringify(dormantPendingEvents)],
    );
    await pool.query(
      `INSERT INTO turns (owner_user_id,campaign_id,turn_number,action,narration,generation_policy,mechanics_private,accepted_at)
       VALUES ($1,$2,1,'Open the gate.','The gate opens.',$3::jsonb,$4::jsonb,now()),
              ($1,$2,2,'Remember the old oath.','The oath remains remembered.',NULL,$5::jsonb,now())`,
      [
        sourceOwnerUserId,
        campaignId,
        JSON.stringify(runtimePolicy),
        JSON.stringify({ roll: 19, retained: "dormant mechanics" }),
        JSON.stringify({ historical: true, retained: "accepted mechanics" }),
      ],
    );
    await pool.query(
      `UPDATE turns SET model_metadata=$3::jsonb
        WHERE owner_user_id=$1 AND campaign_id=$2 AND turn_number=1`,
      [sourceOwnerUserId, campaignId, JSON.stringify({ generationPolicy: runtimePolicy, retained: "accepted metadata" })],
    );

    const records = await exportedRecords(pool, sourceOwnerUserId);
    const campaign = records.find((record) => record.domain === "campaigns");
    const turns = records.filter((record) => record.domain === "turns");
    expect(campaign).toMatchObject({
      formatVersion: 3,
      record: { authority: { turnControlStyle: "flexible_scene", generationPolicyVersion: 1 } },
    });
    expect(turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ authority: expect.objectContaining({
        portableAcceptedGenerationPolicyProvenance: {
          version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
        },
      }) }) }),
      expect.objectContaining({ record: expect.objectContaining({ authority: expect.objectContaining({
        portableAcceptedGenerationPolicyProvenance: null,
      }) }) }),
    ]));
    expect(JSON.stringify(records)).not.toContain("private system prompt");
    expect(JSON.stringify(records)).not.toContain("private repair prompt");

    // Make the same database an intentionally empty destination before import.
    await pool.query("DELETE FROM campaigns WHERE id=$1 AND owner_user_id=$2", [campaignId, sourceOwnerUserId]);
    await pool.query("DELETE FROM world_versions WHERE id=$1 AND owner_user_id=$2", [worldVersionId, sourceOwnerUserId]);
    await pool.query("DELETE FROM worlds WHERE id=$1 AND owner_user_id=$2", [worldId, sourceOwnerUserId]);
    await pool.query("DELETE FROM activity_events WHERE owner_user_id=$1", [sourceOwnerUserId]);
    await pool.query("DELETE FROM users WHERE id=$1", [sourceOwnerUserId]);

    const imports = createPostgresSystemArchiveImportRepository(pool);
    const destination = await imports.destinationFingerprint({ ownerUserId: destinationOwnerUserId }, {});
    expect(destination.destinationEmpty).toBe(true);

    const malformedPolicy = records.map((record) => {
      if (record.domain !== "campaigns" || record.formatVersion !== 3) return record;
      const campaignRecord = record as SystemV3CampaignEnvelope;
      return {
        ...campaignRecord,
        record: {
          ...campaignRecord.record,
          authority: { ...campaignRecord.record.authority, generationPolicyVersion: 2 },
        },
      } as unknown as SystemRecordEnvelope;
    });
    const unknownVersion = records.map((record) => record.domain === "turns" ? { ...record, formatVersion: 99 } : record);
    for (const invalid of [
      malformedPolicy,
      unknownVersion,
    ]) {
      await expect(imports.withAtomicImport({ ownerUserId: destinationOwnerUserId }, { destination, ignore: {} }, async (transaction) => {
        await transaction.insertLogicalDomains(invalid as unknown as SystemRecordEnvelope[]);
      })).rejects.toThrow();
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM campaigns"))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
      await expect(pool.query<{ count: string }>("SELECT count(*)::text AS count FROM worlds"))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
    }

    const externalV3Records = records.map((record) => {
      if (record.domain !== "turns" || record.formatVersion !== 3) return record;
      const turn = record;
      const canonicalProvenance = turn.record.authority.portableAcceptedGenerationPolicyProvenance;
      return systemRecordEnvelopeSchema.parse({
        ...turn,
        record: {
          ...turn.record,
          authority: {
            ...turn.record.authority,
            modelMetadata: turn.record.turnNumber === 1
              ? {
                retained: "external metadata without portable provenance",
                generationPolicy: externalRuntimePolicySnapshot,
              }
              : {
                retained: "external metadata with conflicting portable provenance",
                generationPolicy: externalRuntimePolicySnapshot,
                portableAcceptedGenerationPolicyProvenance: {
                  version: 1,
                  playMode: "story_only",
                  turnControlStyle: "flexible_scene",
                  protocolVersion: "story-only-v1",
                },
              },
            portableAcceptedGenerationPolicyProvenance: canonicalProvenance,
          },
        },
      });
    });

    await imports.withAtomicImport({ ownerUserId: destinationOwnerUserId }, { destination, ignore: {} }, async (transaction) => {
      await transaction.insertLogicalDomains(externalV3Records);
    });
    const imported = await pool.query<{
      owner_user_id: string;
      turn_control_style: string;
      rpg_stats: unknown;
      pending_event_triggers: unknown;
      generation_policy: unknown;
      model_metadata: Record<string, unknown>;
      mechanics_private: unknown;
    }>(
      `SELECT campaign.owner_user_id,campaign.turn_control_style,state.rpg_stats,state.pending_event_triggers,
              turn_row.generation_policy,turn_row.model_metadata,turn_row.mechanics_private
         FROM campaigns campaign
         JOIN campaign_state state ON state.campaign_id=campaign.id
         JOIN turns turn_row ON turn_row.campaign_id=campaign.id
        WHERE campaign.id=$1
        ORDER BY turn_row.turn_number`,
      [campaignId],
    );
    expect(imported.rows).toHaveLength(2);
    expect(imported.rows.map((row) => row.owner_user_id)).toEqual([destinationOwnerUserId, destinationOwnerUserId]);
    expect(imported.rows[0]).toMatchObject({
      turn_control_style: "flexible_scene",
      rpg_stats: dormantStats,
      pending_event_triggers: dormantPendingEvents,
      generation_policy: null,
      mechanics_private: { roll: 19, retained: "dormant mechanics" },
    });
    expect(imported.rows[1]).toMatchObject({
      generation_policy: null,
      mechanics_private: { historical: true, retained: "accepted mechanics" },
    });
    expect(imported.rows[0]!.model_metadata.portableAcceptedGenerationPolicyProvenance).toEqual({
      version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1",
    });
    expect(imported.rows[0]!.model_metadata).toMatchObject({
      retained: "external metadata without portable provenance",
    });
    expect(imported.rows[0]!.model_metadata).not.toHaveProperty("generationPolicy");
    expect(imported.rows[1]!.model_metadata.portableAcceptedGenerationPolicyProvenance).toBeNull();
    expect(imported.rows[1]!.model_metadata).toMatchObject({
      retained: "external metadata with conflicting portable provenance",
    });
    expect(JSON.stringify(imported.rows)).not.toContain("EXTERNAL_RUNTIME_SYSTEM_SENTINEL");
    expect(JSON.stringify(imported.rows)).not.toContain("EXTERNAL_RUNTIME_REPAIR_SENTINEL");

    const reexportedTurns = (await exportedRecords(pool, destinationOwnerUserId)).filter(
      (record): record is SystemV3TurnEnvelope => record.domain === "turns" && record.formatVersion === 3,
    );
    expect(reexportedTurns.sort((left, right) => left.record.turnNumber - right.record.turnNumber)
      .map((record) => record.record.authority.portableAcceptedGenerationPolicyProvenance)).toEqual([
      { version: 1, playMode: "story_only", turnControlStyle: "flexible_scene", protocolVersion: "story-only-v1" },
      null,
    ]);
    expect(reexportedTurns.find((record) => record.record.turnNumber === 1)?.record.authority.modelMetadata)
      .toMatchObject({ retained: "external metadata without portable provenance" });
    expect(reexportedTurns.find((record) => record.record.turnNumber === 1)?.record.authority.modelMetadata)
      .not.toHaveProperty("generationPolicy");
  }, 30_000);
});
