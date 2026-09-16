import { describe, expect, it, vi } from "vitest";
import {
  loadCurrentContinuityCorrection,
  materializeGenerationContinuity,
  materializeAcceptedGenerationContinuity,
  materializeCorrectedGenerationContinuity,
  materializeInitialGenerationContinuity,
  loadAcceptedGenerationContinuity
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
    const client = clientReturning([{ id, content: "The keeper returned." }]);
    const result = await loadAcceptedGenerationContinuity(client, scope, { turnId, turnNumber: 3, snapshot });
    expect(result.canonicalFacts).toEqual([{ id, content: "The keeper returned." }, { id: null, content: "The gate is open." }, { id: null, content: "The bell rang." }]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("source_turn_id=$6"), expect.arrayContaining([[id, expect.any(String)]]));
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
