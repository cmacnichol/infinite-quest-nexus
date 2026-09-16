import { expect, it } from "vitest";
import {
  preseedAcceptedTurnSnapshotFactIds,
  remapAcceptedTurnSnapshotFactReferences
} from "../../packages/database/src/canonical-fact-reference-remapping.js";
import { buildCanonicalChronicleFacts } from "../../packages/domain/src/chronicle-memory-helpers.js";

it("remaps portable object fact identities and later supersession references consistently", () => {
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const input = { sourceCampaignId: "00000000-0000-4000-8000-000000000002", sourceTurnId: "00000000-0000-4000-8000-000000000003",
    destinationCampaignId: "00000000-0000-4000-8000-000000000004", destinationTurnId: "00000000-0000-4000-8000-000000000005", factIds: new Map<string, string>() };
  const snapshot = { canonicalFacts: [{ id: sourceId, content: "The keeper owns the seal." }, { id: null, content: "The gate is open." }] };
  const mapped = remapAcceptedTurnSnapshotFactReferences(snapshot, input);
  const expectedId = buildCanonicalChronicleFacts({ campaignId: input.destinationCampaignId, turnId: input.destinationTurnId, canonicalFacts: ["The keeper owns the seal.", "The gate is open."], entityCatalog: [] })[0]!.id;
  expect(mapped.canonicalFacts).toEqual([{ id: expectedId, content: "The keeper owns the seal." }, { id: null, content: "The gate is open." }]);
  const later = remapAcceptedTurnSnapshotFactReferences({ canonicalFactUpdates: [{ content: "The seal is broken.", supersedesFactIds: [sourceId] }] }, { ...input, sourceTurnId: "00000000-0000-4000-8000-000000000006", destinationTurnId: "00000000-0000-4000-8000-000000000007" });
  expect(later.canonicalFactUpdates).toEqual([{ content: "The seal is broken.", supersedesFactIds: [expectedId] }]);
  expect(snapshot.canonicalFacts[0]!.id).toBe(sourceId);
  const unknown = "00000000-0000-4000-8000-000000000009";
  const untrusted = remapAcceptedTurnSnapshotFactReferences({ canonicalFactUpdates: [{ content: "The gate opens.", supersedesFactIds: [unknown] }] }, input);
  expect(untrusted.canonicalFactUpdates).toEqual([{ content: "The gate opens.", supersedesFactIds: [] }]);
});

it("preserves the first destination identity when an object fact is repeated in later accepted snapshots", () => {
  const sourceCampaignId = "00000000-0000-4000-8000-000000000010";
  const destinationCampaignId = "00000000-0000-4000-8000-000000000011";
  const sourceTurnOneId = "00000000-0000-4000-8000-000000000012";
  const sourceTurnTwoId = "00000000-0000-4000-8000-000000000013";
  const destinationTurnOneId = "00000000-0000-4000-8000-000000000014";
  const destinationTurnTwoId = "00000000-0000-4000-8000-000000000015";
  const repeatedSourceFactId = buildCanonicalChronicleFacts({
    campaignId: sourceCampaignId,
    turnId: sourceTurnOneId,
    canonicalFacts: ["The lantern is lit."],
    entityCatalog: []
  })[0]!.id;
  const expectedDestinationFactId = buildCanonicalChronicleFacts({
    campaignId: destinationCampaignId,
    turnId: destinationTurnOneId,
    canonicalFacts: ["The lantern is lit."],
    entityCatalog: []
  })[0]!.id;
  const factIds = new Map<string, string>();
  const firstSnapshot = { canonicalFacts: [{ id: repeatedSourceFactId, content: "The lantern is lit." }] };
  const secondSnapshot = { canonicalFacts: [{ id: repeatedSourceFactId, content: "The lantern is lit." }] };

  preseedAcceptedTurnSnapshotFactIds(firstSnapshot, {
    sourceCampaignId, sourceTurnId: sourceTurnOneId, destinationCampaignId, destinationTurnId: destinationTurnOneId, factIds
  });
  preseedAcceptedTurnSnapshotFactIds(secondSnapshot, {
    sourceCampaignId, sourceTurnId: sourceTurnTwoId, destinationCampaignId, destinationTurnId: destinationTurnTwoId, factIds
  });

  expect(remapAcceptedTurnSnapshotFactReferences(secondSnapshot, {
    sourceCampaignId, sourceTurnId: sourceTurnTwoId, destinationCampaignId, destinationTurnId: destinationTurnTwoId, factIds
  }).canonicalFacts).toEqual([{ id: expectedDestinationFactId, content: "The lantern is lit." }]);
});
