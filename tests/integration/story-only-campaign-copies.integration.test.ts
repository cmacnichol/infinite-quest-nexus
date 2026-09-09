import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { campaignCreateSchema, worldContentSchema, worldCreateSchema, worldPublishSchema } from "../../packages/contracts/src/world-library.js";
import { campaignBranchSchema } from "../../packages/contracts/src/generation.js";
import { campaignTransferCommitRequestSchema, campaignTransferPreviewRequestSchema } from "../../packages/contracts/src/campaign-transfer.js";
import { createDatabasePool, initialOwnerId, type DatabasePool } from "../../packages/database/src/pool.js";
import { migrateDatabase } from "../../packages/database/src/migrate.js";
import { branchCampaign, createCampaign, createWorld, previewCampaignWorldTransfer, publishWorld, transferCampaignWorld } from "../helpers/memory-aware-services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const storyOnlyProvenance = {
  version: 1,
  playMode: "story_only",
  turnControlStyle: "flexible_scene",
  protocolVersion: "story-only-v1"
} as const;

const runtimeStoryOnlyPolicy = {
  ...storyOnlyProvenance,
  prompts: {
    systemSupplement: "Private runtime supplement.",
    systemSupplementHash: "runtime-supplement-hash",
    choiceRepairSystem: "Private repair instruction.",
    choiceRepairSystemHash: "runtime-repair-hash"
  }
};

function content(title: string, characterId: string) {
  return worldContentSchema.parse({
    schemaVersion: 4,
    world: {
      title,
      genre: "synthetic",
      tone: "neutral",
      premise: `Premise for ${title}`,
      backgroundStory: `Background for ${title}`,
      firstAction: "Begin.",
      rules: "Synthetic rules."
    },
    playableCharacters: [{ id: characterId, name: `Character ${characterId}`, characterText: "Synthetic guidance." }]
  });
}

integration("story-only campaign copies", () => {
  let pool: DatabasePool;
  let ownerUserId: string;

  beforeAll(async () => {
    pool = createDatabasePool(databaseUrl!, 4);
    await migrateDatabase(pool, resolve("database/migrations"));
    ownerUserId = await initialOwnerId(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function publishedWorld(label: string, characterId: string) {
    const title = `${label} ${crypto.randomUUID()}`;
    const created = await createWorld(pool, worldCreateSchema.parse({ title, content: content(title, characterId) }));
    const version = await publishWorld(pool, created.id, worldPublishSchema.parse({ expectedRevision: created.draftRevision }));
    return { ...created, ...version };
  }

  async function sourceCampaign(label: string) {
    const world = await publishedWorld(`${label} source`, "source-hero");
    const campaign = await createCampaign(pool, campaignCreateSchema.parse({
      worldVersionId: world.worldVersionId,
      title: `${label} campaign ${crypto.randomUUID()}`,
      selectedCharacterId: "source-hero",
      turnControlStyle: "flexible_scene"
    }));
    await pool.query(
      `UPDATE campaign_state
          SET trackers = $3::jsonb,
              default_triggers = $4::jsonb,
              initial_state_snapshot = $5::jsonb
        WHERE owner_user_id = $1 AND campaign_id = $2`,
      [ownerUserId, campaign.id,
        JSON.stringify([{ id: "dormant-stat", name: "Dormant stat", value: "7", rules: "Do not erase." }]),
        JSON.stringify([{ id: "pending-event", name: "Pending event", value: "unresolved", rules: "Preserve." }]),
        JSON.stringify({
          scratchpad: "", trackers: [{ id: "dormant-stat", name: "Dormant stat", value: "7", rules: "Do not erase." }],
          eventTriggers: [], pendingEventTriggers: [{ id: "pending-event", sourceTriggerId: "source-event", name: "Pending event", timing: "after", instructions: "Preserve.", condition: "", effect: "", reason: "", sourceTurn: 1 }], rpgStats: [{ id: "dormant-stat", name: "Dormant stat", value: 7, note: "Do not erase." }],
          continuitySummary: "", openThreads: [], canonicalFacts: []
        })]
    );
    return { world, campaign };
  }

  async function acceptedTurn(campaignId: string, generationPolicy: unknown, portableProvenance: unknown) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO turns (
         owner_user_id, campaign_id, turn_number, action, narration, choices,
         mechanics_private, state_snapshot_private, model_metadata, generation_policy
       ) VALUES ($1,$2,1,'Open the gate.','The gate opens.','[]',$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)
       RETURNING id`,
      [ownerUserId, campaignId,
        JSON.stringify({ dice: [{ sides: 20, result: 17 }], internal: "dormant mechanics" }),
        JSON.stringify({
          scratchpad: "", trackers: [{ id: "dormant-stat", name: "Dormant stat", value: "7", rules: "Do not erase." }],
          eventTriggers: [], pendingEventTriggers: [{ id: "pending-event", sourceTriggerId: "source-event", name: "Pending event", timing: "after", instructions: "Preserve.", condition: "", effect: "", reason: "", sourceTurn: 1 }], rpgStats: [{ id: "dormant-stat", name: "Dormant stat", value: 7, note: "Do not erase." }],
          continuitySummary: "", openThreads: [], canonicalFacts: []
        }),
        JSON.stringify({
          retainedAcceptedMetadata: "keep this accepted metadata",
          generationPolicy,
          portableAcceptedGenerationPolicyProvenance: portableProvenance
        }),
        generationPolicy === null ? null : JSON.stringify(generationPolicy)]
    );
    await pool.query("UPDATE campaigns SET active_turn_number = 1 WHERE id = $1 AND owner_user_id = $2", [campaignId, ownerUserId]);
    return inserted.rows[0]!.id;
  }

  async function copiedCampaignEvidence(campaignId: string) {
    return pool.query<{
      turnControlStyle: string;
      initialStateSnapshot: unknown;
      trackers: unknown;
      pendingEvents: unknown;
      mechanicsPrivate: unknown;
      stateSnapshotPrivate: unknown;
      generationPolicy: unknown;
      modelMetadata: { portableAcceptedGenerationPolicyProvenance?: unknown };
    }>(
      `SELECT c.turn_control_style AS "turnControlStyle",
              cs.initial_state_snapshot AS "initialStateSnapshot", cs.trackers, cs.default_triggers AS "pendingEvents",
              t.mechanics_private AS "mechanicsPrivate", t.state_snapshot_private AS "stateSnapshotPrivate",
              t.generation_policy AS "generationPolicy", t.model_metadata AS "modelMetadata"
         FROM campaigns c
         JOIN campaign_state cs ON cs.campaign_id = c.id AND cs.owner_user_id = c.owner_user_id
         JOIN turns t ON t.campaign_id = c.id AND t.owner_user_id = c.owner_user_id AND t.turn_number = 1
        WHERE c.id = $1 AND c.owner_user_id = $2`,
      [campaignId, ownerUserId]
    );
  }

  it("keeps story direction, dormant state, and accepted policy provenance through branch and cross-world transfer", async () => {
    const source = await sourceCampaign("Copy policy");
    const target = await publishedWorld("Copy policy target", "target-hero");
    await acceptedTurn(source.campaign.id, runtimeStoryOnlyPolicy, null);
    const sourceEvidence = await copiedCampaignEvidence(source.campaign.id);

    const branch = await branchCampaign(pool, source.campaign.id, campaignBranchSchema.parse({
      targetTurnNumber: 1,
      expectedCurrentTurnNumber: 1
    }));
    const previewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId });
    const preview = await previewCampaignWorldTransfer(pool, source.campaign.id, previewRequest);
    const transferRequest = campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    });
    const transferred = await transferCampaignWorld(pool, source.campaign.id, transferRequest);
    expect(await transferCampaignWorld(pool, source.campaign.id, transferRequest)).toMatchObject({
      targetCampaignId: transferred.targetCampaignId,
      reused: true
    });

    for (const destinationId of [branch.id, transferred.targetCampaignId]) {
      const copied = await copiedCampaignEvidence(destinationId);
      expect(copied.rows[0]).toMatchObject({
        turnControlStyle: "flexible_scene",
        initialStateSnapshot: { rpgStats: [{ id: "dormant-stat", name: "Dormant stat", value: 7, note: "Do not erase." }], pendingEventTriggers: [{ id: "pending-event", sourceTriggerId: "source-event", name: "Pending event", timing: "after", instructions: "Preserve.", condition: "", effect: "", reason: "", sourceTurn: 1 }] },
        trackers: [{ id: "dormant-stat", name: "Dormant stat", value: "7", rules: "Do not erase." }],
        pendingEvents: [{ id: "pending-event", name: "Pending event", value: "unresolved", rules: "Preserve." }],
        mechanicsPrivate: { dice: [{ sides: 20, result: 17 }], internal: "dormant mechanics" },
        stateSnapshotPrivate: { rpgStats: [{ id: "dormant-stat", name: "Dormant stat", value: 7, note: "Do not erase." }], pendingEventTriggers: [{ id: "pending-event", sourceTriggerId: "source-event", name: "Pending event", timing: "after", instructions: "Preserve.", condition: "", effect: "", reason: "", sourceTurn: 1 }] },
        generationPolicy: null,
        modelMetadata: { portableAcceptedGenerationPolicyProvenance: storyOnlyProvenance }
      });
      expect(copied.rows[0]?.initialStateSnapshot).toEqual(sourceEvidence.rows[0]?.initialStateSnapshot);
      expect(copied.rows[0]?.mechanicsPrivate).toEqual(sourceEvidence.rows[0]?.mechanicsPrivate);
      expect(copied.rows[0]?.stateSnapshotPrivate).toEqual(sourceEvidence.rows[0]?.stateSnapshotPrivate);
      expect(copied.rows[0]?.modelMetadata).not.toHaveProperty("generationPolicy");
      expect(JSON.stringify(copied.rows[0]?.modelMetadata)).not.toContain(runtimeStoryOnlyPolicy.prompts.systemSupplement);
      expect(JSON.stringify(copied.rows[0]?.modelMetadata)).not.toContain(runtimeStoryOnlyPolicy.prompts.choiceRepairSystem);
      expect(copied.rows[0]?.modelMetadata).toMatchObject({ retainedAcceptedMetadata: "keep this accepted metadata" });
    }
  });

  it("retains imported and historical accepted-policy provenance and rejects a transfer whose provenance changes after preview", async () => {
    const source = await sourceCampaign("Copy provenance guard");
    const importedTarget = await publishedWorld("Copy imported provenance target", "imported-target-hero");
    const target = await publishedWorld("Copy provenance guard target", "target-hero");
    await acceptedTurn(source.campaign.id, null, storyOnlyProvenance);
    const importedBranch = await branchCampaign(pool, source.campaign.id, campaignBranchSchema.parse({
      targetTurnNumber: 1,
      expectedCurrentTurnNumber: 1
    }));
    expect((await copiedCampaignEvidence(importedBranch.id)).rows[0]).toMatchObject({
      turnControlStyle: "flexible_scene",
      generationPolicy: null,
      modelMetadata: { portableAcceptedGenerationPolicyProvenance: storyOnlyProvenance }
    });
    const importedTransferPreviewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: importedTarget.worldVersionId });
    const importedPreview = await previewCampaignWorldTransfer(pool, source.campaign.id, importedTransferPreviewRequest);
    const importedTransfer = await transferCampaignWorld(pool, source.campaign.id, campaignTransferCommitRequestSchema.parse({
      ...importedTransferPreviewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: importedPreview.expectedActiveTurnNumber,
      expectedStateRevision: importedPreview.expectedStateRevision,
      sourceFingerprint: importedPreview.sourceFingerprint
    }));
    expect((await copiedCampaignEvidence(importedTransfer.targetCampaignId)).rows[0]).toMatchObject({
      turnControlStyle: "flexible_scene",
      generationPolicy: null,
      modelMetadata: { portableAcceptedGenerationPolicyProvenance: storyOnlyProvenance }
    });
    const previewRequest = campaignTransferPreviewRequestSchema.parse({ targetWorldVersionId: target.worldVersionId });
    const preview = await previewCampaignWorldTransfer(pool, source.campaign.id, previewRequest);
    const destinationCount = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1", [ownerUserId]);
    await pool.query(
      `UPDATE turns
          SET model_metadata = jsonb_set(model_metadata, '{portableAcceptedGenerationPolicyProvenance}', 'null'::jsonb)
        WHERE owner_user_id = $1 AND campaign_id = $2 AND turn_number = 1`,
      [ownerUserId, source.campaign.id]
    );

    await expect(transferCampaignWorld(pool, source.campaign.id, campaignTransferCommitRequestSchema.parse({
      ...previewRequest,
      idempotencyKey: crypto.randomUUID(),
      expectedActiveTurnNumber: preview.expectedActiveTurnNumber,
      expectedStateRevision: preview.expectedStateRevision,
      sourceFingerprint: preview.sourceFingerprint
    }))).rejects.toMatchObject({ statusCode: 409 });
    expect((await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM campaigns WHERE owner_user_id = $1", [ownerUserId])).rows[0]?.count)
      .toBe(destinationCount.rows[0]?.count);

    const historicalBranch = await branchCampaign(pool, source.campaign.id, campaignBranchSchema.parse({
      targetTurnNumber: 1,
      expectedCurrentTurnNumber: 1
    }));
    const historical = await copiedCampaignEvidence(historicalBranch.id);
    expect(historical.rows[0]).toMatchObject({
      generationPolicy: null,
      modelMetadata: { portableAcceptedGenerationPolicyProvenance: null }
    });
  });

  it("projects a legacy runtime policy through a branch without copying runtime policy", async () => {
    const source = await sourceCampaign("Copy legacy policy");
    await acceptedTurn(source.campaign.id, {
      version: 1,
      playMode: "legacy",
      turnControlStyle: "flexible_action"
    }, null);

    const branch = await branchCampaign(pool, source.campaign.id, campaignBranchSchema.parse({
      targetTurnNumber: 1,
      expectedCurrentTurnNumber: 1
    }));

    expect((await copiedCampaignEvidence(branch.id)).rows[0]).toMatchObject({
      generationPolicy: null,
      modelMetadata: {
        portableAcceptedGenerationPolicyProvenance: {
          version: 1,
          playMode: "legacy",
          turnControlStyle: "flexible_action",
          protocolVersion: null
        }
      }
    });
  });
});
