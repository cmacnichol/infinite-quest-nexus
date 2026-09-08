import assert from "node:assert/strict";
import test from "node:test";
import * as allowlist from "./source-smoke-fact-allowlist.mjs";

const facts = [
  {
    id: "safe-fact-1", kind: "character", provenance: "stated", subject: "Mara", predicate: "keeps the harbor gate", value: "at dusk",
    citations: [{ quote: "Mara keeps the harbor gate at dusk." }]
  },
  {
    id: "safe-fact-2", kind: "character", provenance: "stated", subject: "Mara", predicate: "carries", value: "the brass key",
    citations: [{ quote: "Mara carries the brass key" }]
  },
  {
    id: "safe-fact-3", kind: "character", provenance: "stated", subject: "Mara", predicate: "asks visitors", value: "to name their purpose",
    citations: [{ quote: "Mara carries the brass key and asks visitors to name their purpose." }]
  }
];

test("accepts only the reviewed alternate tuple and quote forms", () => {
  const expected = {
    subject: "mara",
    variants: [{ predicate: "keeps the harbor gate", value: "at dusk", quotes: ["Mara keeps the harbor gate at dusk."] }]
  };

  assert.equal(allowlist.findAllowedFact(facts, expected)?.id, "safe-fact-1");
});

test("rejects an otherwise matching fact with a different value", () => {
  const expected = {
    subject: "mara",
    variants: [{ predicate: "keeps the harbor gate", value: "at dawn", quotes: ["Mara keeps the harbor gate at dusk."] }]
  };

  assert.equal(allowlist.findAllowedFact(facts, expected), undefined);
});

test("rejects an otherwise matching fact with an unsupported quote", () => {
  const expected = {
    subject: "mara",
    variants: [{ predicate: "carries", value: "the brass key", quotes: ["Mara carries the brass key and asks visitors to name their purpose."] }]
  };

  assert.equal(allowlist.findAllowedFact(facts, expected), undefined);
});
