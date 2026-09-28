import { describe, expect, it, vi } from "vitest";
import {
  loadCurrentContinuityCorrection,
  materializeGenerationContinuity,
  materializeAcceptedGenerationContinuity,
  materializeCorrectedGenerationContinuity,
  materializeInitialGenerationContinuity,
  loadAcceptedGenerationContinuity,
  loadVerifiedProtectedFacts,
  verifyCapturedOptionalGenerationFacts
} from "../../packages/database/src/campaign-continuity-repository.js";
import type { DatabaseClient } from "../../packages/database/src/pool.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";
import { createCorrectionCanonicalFactId } from "../../packages/domain/src/canonical-facts.js";

const scope = {
  ownerUserId: "00000000-0000-4000-8000-000000000001",
  campaignId: "00000000-0000-4000-8000-000000000002",
  worldVersionId: "00000000-0000-4000-8000-000000000003"
};

function clientReturning(rows: readonly Record<string, unknown>[]): DatabaseClient {
  return {
    query: vi.fn(async () => ({ rows }))
  } as unknown as DatabaseClient;
}

describe("loadCurrentContinuityCorrection", () => {
  it("withholds pre-correction projection rows absent from an earlier empty frontier while retaining later verified facts", async () => {
    const retainedTurnId = "00000000-0000-4000-8000-000000000004";
    const staleTurnId = "00000000-0000-4000-8000-000000000005";
    const retained = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: retainedTurnId,
      canonicalFacts: ["The old gate is open."], entityCatalog: [] })[0]!;
    const later = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId: staleTurnId,
      canonicalFacts: ["A new brass key is visible."], entityCatalog: [] })[0]!;
    const queries: string[] = [];
    const client = { query: vi.fn(async (statement: string) => {
      queries.push(statement);
      if (statement.includes("FROM campaign_canonical_facts fact")) return { rows: [
        { id: retained.id, content: retained.content, source_turn_number: 1, source_fact_index: 0, source_turn_id: retainedTurnId, source_state_edit_id: null },
        { id: later.id, content: later.content, source_turn_number: 3, source_fact_index: 0, source_turn_id: staleTurnId, source_state_edit_id: null }
      ] };
      if (statement.includes("FROM campaign_state_edits edit")) return { rows: [{ id: "00000000-0000-4000-8000-000000000006", effective_turn_number: 2, canonical_facts: [] }] };
      if (statement.includes("octet_length")) return { rows: [
        { id: retainedTurnId, source_bytes: 100 }, { id: staleTurnId, source_bytes: 100 }
      ] };
      if (statement.includes("FROM turns turn_row")) return { rows: [
        { id: retainedTurnId, turn_number: 1, canonical_facts: ["The old gate is open."], canonical_fact_updates: [] },
        { id: staleTurnId, turn_number: 3, canonical_facts: ["A new brass key is visible."], canonical_fact_updates: [] }
      ] };
      throw new Error(`Unexpected query: ${statement}`);
    }) } as unknown as DatabaseClient;

    await expect(loadVerifiedProtectedFacts(client, scope, 3)).resolves.toMatchObject({
      facts: [{ id: later.id, turnNumber: 3, content: "A new brass key is visible." }],
      omittedCount: 1
    });
    expect(queries.every((statement) => /^\s*SELECT/u.test(statement))).toBe(true);
  });

  it("withholds oversized and future-source candidates before source materialization and reports bounded coverage", async () => {
    const turnId = "00000000-0000-4000-8000-000000000004";
    const fact = buildCanonicalChronicleFacts({ campaignId: scope.campaignId, turnId,
      canonicalFacts: ["The safe harbor bell rings at dawn."], entityCatalog: [] })[0]!;
    const client = { query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM campaign_canonical_facts fact")) return { rows: [
        { id: fact.id, content: fact.content, source_turn_number: 2, source_fact_index: 0, source_turn_id: turnId, source_state_edit_id: null },
        { id: "00000000-0000-4000-8000-000000000007", content: null, source_turn_number: 2, source_fact_index: 1, source_turn_id: turnId, source_state_edit_id: null },
        { id: "00000000-0000-4000-8000-000000000008", content: "A future row must not be trusted.", source_turn_number: 4, source_fact_index: 0, source_turn_id: "00000000-0000-4000-8000-000000000009", source_state_edit_id: null }
      ] };
      if (statement.includes("FROM campaign_state_edits edit")) return { rows: [] };
      if (statement.includes("octet_length")) return { rows: [{ id: turnId, source_bytes: 100 }] };
      if (statement.includes("FROM turns turn_row")) return { rows: [{ id: turnId, turn_number: 2,
        canonical_facts: ["The safe harbor bell rings at dawn."], canonical_fact_updates: [] }] };
      throw new Error(`Unexpected query: ${statement}`);
    }) } as unknown as DatabaseClient;

    await expect(loadVerifiedProtectedFacts(client, scope, 3)).resolves.toMatchObject({
      facts: [{ id: fact.id, turnNumber: 2, content: fact.content }],
      omittedCount: 2,
      coverage: { candidateRows: 3, oversizedCandidateCount: 1, futureSourceCount: 1, withheldCandidateCount: 2 }
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("turn_row.turn_number <= $5"), expect.any(Array));
  });

  it("combines accepted structured updates first with plain additions using persisted identities", () => {
    const turnId = "00000000-0000-4000-8000-000000000004";
    const snapshot = { canonicalFacts: ["The gate is open.", "The keeper has departed."],
      canonicalFactUpdates: [{ content: "The gate is open.", supersedesFactIds: ["00000000-0000-4000-8000-000000000005"] }] };
    const facts = buildCanonicalChronicleFacts({ ...snapshot, campaignId: scope.campaignId, turnId, entityCatalog: [] });
    const materialized = materializeAcceptedGenerationContinuity(snapshot, { campaignId: scope.campaignId, turnId }, facts);
    expect(materialized.canonicalFacts).toEqual(facts.map((fact) => ({ id: fact.id, content: fact.content })));
    expect(materialized.canonicalFacts).toHaveLength(2);
    expect(materializeAcceptedGenerationContinuity(snapshot, { campaignId: scope.campaignId, turnId }, []).canonicalFacts)
      .toEqual(facts.map((fact) => ({ id: null, content: fact.content })));
  });

  it("reads portable object facts and mixed additions without inventing null identities", async () => {
    const turnId = "00000000-0000-4000-8000-000000000004";
    const id = "00000000-0000-4000-8000-000000000005";
    const snapshot = { canonicalFacts: [{ id, content: "The keeper returned." }, { id: null, content: "The gate is open." }, "The bell rang."] };
    const client = clientReturning([{ id, content: "The keeper returned.", factIndex: 0 }]);
    const result = await loadAcceptedGenerationContinuity(client, scope, { turnId, turnNumber: 3, snapshot });
    expect(result.canonicalFacts).toEqual([{ id, content: "The keeper returned." }, { id: null, content: "The gate is open." }, { id: null, content: "The bell rang." }]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("source_turn_id=$6"), expect.arrayContaining([[id, expect.any(String)]]));
  });

  it("withholds an explicit accepted fact ID when its active projection index disagrees", () => {
    const turnId = "00000000-0000-4000-8000-000000000004";
    const id = "00000000-0000-4000-8000-000000000005";
    const snapshot = { canonicalFacts: [{ id, content: "The keeper returned." }] };

    expect(materializeAcceptedGenerationContinuity(snapshot, { campaignId: scope.campaignId, turnId }, [
      { id, content: "The keeper returned.", factIndex: 1 }
    ]).canonicalFacts).toEqual([{ id: null, content: "The keeper returned." }]);
  });

  it("rejects accepted source values that the derived helper would silently clip", () => {
    const identity = { campaignId: scope.campaignId, turnId: "00000000-0000-4000-8000-000000000004" };
    expect(() => materializeAcceptedGenerationContinuity({ canonicalFactUpdates: [{ content: "x".repeat(4_001) }] }, identity, [])).toThrow();
    expect(() => materializeAcceptedGenerationContinuity({ canonicalFacts: Array.from({ length: 101 }, (_, index) => `Fact ${index}.`) }, identity, [])).toThrow();
  });

  it("does not grant a source UUID when the active projection content disagrees", async () => {
    const turnId = "00000000-0000-4000-8000-000000000004";
    const snapshot = { canonicalFactUpdates: [{ content: "The gate is open." }] };
    const fact = buildCanonicalChronicleFacts({ ...snapshot, campaignId: scope.campaignId, turnId, entityCatalog: [] })[0]!;
    const client = clientReturning([{ id: fact.id, content: "The gate is closed." }]);
    const result = await loadAcceptedGenerationContinuity(client, scope, { turnId, turnNumber: 3, snapshot });
    expect(result.canonicalFacts).toEqual([{ id: null, content: "The gate is open." }]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("valid_until_turn > $4"), [
      scope.ownerUserId, scope.campaignId, scope.worldVersionId, 3, [fact.id], turnId, null, []
    ]);
  });

  it("uses correction identities for null IDs and never fills an intentional empty correction", () => {
    const state = materializeGenerationContinuity({ canonicalFacts: ["The keeper returned."] });
    const stateEditId = "00000000-0000-4000-8000-000000000005";
    const id = createCorrectionCanonicalFactId(scope.campaignId, stateEditId, 0);
    expect(materializeCorrectedGenerationContinuity(state, { campaignId: scope.campaignId, stateEditId }, [{ id, content: "The keeper returned.", factIndex: 0 }]).canonicalFacts)
      .toEqual([{ id, content: "The keeper returned." }]);
    expect(materializeCorrectedGenerationContinuity({ ...state, canonicalFacts: [], continuitySummary: "", openThreads: [], scratchpad: "" },
      { campaignId: scope.campaignId, stateEditId }, [{ id, content: "The keeper returned." }]).canonicalFacts).toEqual([]);
    expect(() => materializeCorrectedGenerationContinuity({ canonicalFacts: [] }, { campaignId: scope.campaignId, stateEditId }, [])).toThrow();
  });

  it("withholds an explicit correction fact ID when its active projection index disagrees", () => {
    const stateEditId = "00000000-0000-4000-8000-000000000005";
    const id = "00000000-0000-4000-8000-000000000006";
    const state = materializeGenerationContinuity({ canonicalFacts: [{ id, content: "The repaired gate remains open." }] });

    expect(materializeCorrectedGenerationContinuity(state, { campaignId: scope.campaignId, stateEditId }, [
      { id, content: "The repaired gate remains open.", factIndex: 1, sourceStateEditId: stateEditId }
    ]).canonicalFacts).toEqual([{ id: null, content: "The repaired gate remains open." }]);
  });

  it("keeps imported initial prose without manufacturing accepted-turn IDs", () => {
    const fact = { id: "00000000-0000-4000-8000-000000000005", content: "The gate is open." };
    expect(materializeInitialGenerationContinuity({ canonicalFacts: [fact], canonicalFactUpdates: [{ content: "The gate is open." }] }).canonicalFacts)
      .toEqual([{ id: null, content: "The gate is open." }]);
  });
  it("materializes persisted turn facts as editable canonical facts", () => {
    expect(materializeGenerationContinuity({
      continuitySummary: "The keeper is dead.",
      scratchpad: "late password: moonfall",
      openThreads: ["Bury the keeper."],
      canonicalFacts: ["The keeper died defending the gate."]
    })).toEqual({
      continuitySummary: "The keeper is dead.",
      scratchpad: "late password: moonfall",
      openThreads: ["Bury the keeper."],
      canonicalFacts: [{ id: null, content: "The keeper died defending the gate." }],
      trackers: [], rpgStats: [], eventTriggers: [], pendingEventTriggers: []
    });
  });
  it("returns the highest revision at the exact requested base turn, preserving intentional empties", async () => {
    const client = clientReturning([{
      state_snapshot_private: {
        continuitySummary: "The keeper is alive.",
        openThreads: [],
        canonicalFacts: [],
        scratchpad: ""
      }
    }]);

    await expect(loadCurrentContinuityCorrection(client, scope, 7)).resolves.toEqual({
      continuitySummary: "The keeper is alive.",
      openThreads: [],
      canonicalFacts: [],
      scratchpad: "",
      trackers: [],
      rpgStats: [],
      eventTriggers: [],
      pendingEventTriggers: []
    });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("effective_turn_number = $4"), [
      scope.ownerUserId,
      scope.campaignId,
      scope.worldVersionId,
      7
    ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("ORDER BY edit.revision DESC"), expect.any(Array));
  });

  it("returns null when no correction exists at the exact base turn", async () => {
    const client = clientReturning([]);

    await expect(loadCurrentContinuityCorrection(client, scope, 6)).resolves.toBeNull();
  });

  it("rejects malformed persisted correction data instead of producing an uncorrected prompt", async () => {
    const client = clientReturning([{
      state_snapshot_private: {
        continuitySummary: "The keeper is alive.",
        openThreads: "not a list",
        canonicalFacts: [],
        scratchpad: ""
      }
    }]);

    await expect(loadCurrentContinuityCorrection(client, scope, 7)).rejects.toThrow();
  });
});

describe("captured optional Chronicle fact verification", () => {
  it("withholds an active pre-frontier fact after the captured empty correction without rereading it", async () => {
    const staleId = "00000000-0000-4000-8000-000000000010";
    const client = { query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM campaign_canonical_facts")) return { rows: [{
        id: staleId, content: "The old lock still opens.", source_turn_number: 1, source_fact_index: 0,
        source_turn_id: "00000000-0000-4000-8000-000000000011", source_state_edit_id: null
      }] };
      throw new Error(`The captured frontier must avoid a mutable source read: ${statement}`);
    }) } as unknown as DatabaseClient;

    await expect(verifyCapturedOptionalGenerationFacts(client, scope, 3, [staleId], {
      stateEditId: "00000000-0000-4000-8000-000000000012", effectiveTurnNumber: 2, facts: []
    })).resolves.toEqual([]);
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("retains individually verified older optional facts and siblings outside the protected source window", async () => {
    const oldId = "00000000-0000-4000-8000-000000000013";
    const siblingId = "00000000-0000-4000-8000-000000000014";
    const sourceId = "00000000-0000-4000-8000-000000000015";
    const client = { query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM campaign_canonical_facts")) return { rows: [
        { id: oldId, content: "The old observatory lens is silver.", source_turn_number: 3, source_fact_index: 0, source_turn_id: sourceId, source_state_edit_id: null },
        { id: siblingId, content: "Its sibling lens is blue.", source_turn_number: 3, source_fact_index: 1, source_turn_id: sourceId, source_state_edit_id: null }
      ] };
      if (statement.includes("FROM turns")) return { rows: [{ id: sourceId, turn_number: 3, canonical_facts: [
        { id: oldId, content: "The old observatory lens is silver." }, { id: siblingId, content: "Its sibling lens is blue." }
      ], canonical_fact_updates: [] }] };
      throw new Error(`Unexpected query: ${statement}`);
    }) } as unknown as DatabaseClient;

    await expect(verifyCapturedOptionalGenerationFacts(client, scope, 600, [oldId, siblingId], {
      stateEditId: "00000000-0000-4000-8000-000000000016", effectiveTurnNumber: 2, facts: []
    })).resolves.toEqual(expect.arrayContaining([oldId, siblingId]));
  });

  it("withholds a mismatched optional source projection while retaining its verified sibling", async () => {
    const validId = "00000000-0000-4000-8000-000000000017";
    const mismatchedId = "00000000-0000-4000-8000-000000000018";
    const sourceId = "00000000-0000-4000-8000-000000000019";
    const client = { query: vi.fn(async (statement: string) => {
      if (statement.includes("FROM campaign_canonical_facts")) return { rows: [
        { id: validId, content: "The moon key is whole.", source_turn_number: 3, source_fact_index: 0, source_turn_id: sourceId, source_state_edit_id: null },
        { id: mismatchedId, content: "The tampered moon key is whole.", source_turn_number: 3, source_fact_index: 1, source_turn_id: sourceId, source_state_edit_id: null }
      ] };
      if (statement.includes("FROM turns")) return { rows: [{ id: sourceId, turn_number: 3,
        canonical_facts: [{ id: validId, content: "The moon key is whole." }], canonical_fact_updates: [] }] };
      throw new Error(`Unexpected query: ${statement}`);
    }) } as unknown as DatabaseClient;

    await expect(verifyCapturedOptionalGenerationFacts(client, scope, 3, [validId, mismatchedId], undefined))
      .resolves.toEqual([validId]);
  });
});
