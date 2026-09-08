import assert from "node:assert/strict";
import test from "node:test";

import { sourceWorldReady } from "./source-smoke-world-readiness.mjs";

const selectedFactId = "source-fact:1a5fe9c7-320e-4b77-95bc-b1cbcd65002f:892b68e877972fc4f3e673713c02e1828b7f010f244e931421a5d756b56c3346";
const synthesis = { id: "synthesis", key: "source:synthesis", generation: 1, status: "validated" };
const character = { id: "character", key: `source:character:${selectedFactId}`, generation: 1, status: "validated" };

function job(stages) {
  return {
    status: "awaiting_review",
    canApply: true,
    result: { world: { title: "Synthetic Harbor" } },
    source: { selectedCharacterFactIds: [selectedFactId] },
    stages
  };
}

test("does not adopt a source world while its selected character is still pending", () => {
  assert.equal(sourceWorldReady(job([synthesis, { ...character, status: "running" }])), false);
});

test("requires a current validated character stage after synthesis", () => {
  assert.equal(sourceWorldReady(job([synthesis, character])), true);
});

test("uses the current generation rather than a historical validated character", () => {
  assert.equal(sourceWorldReady(job([
    synthesis,
    character,
    { ...character, id: "character-next", generation: 2, status: "running" }
  ])), false);
});

test("does not accept a different character stage when the selected fact is missing", () => {
  assert.equal(sourceWorldReady(job([synthesis, { ...character, key: "source:character:source-fact:other:hash" }])), false);
});

test("ignores an unselected historical character stage", () => {
  assert.equal(sourceWorldReady(job([synthesis, character, { ...character, key: "source:character:source-fact:other:hash", status: "cancelled" }])), true);
});
