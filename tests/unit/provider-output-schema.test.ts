import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  findProviderOutputSchemaV2,
  findProviderOutputSchemaV2ByHash,
  getProviderOutputSchemaV2,
  providerOutputSchemaVersionsV2,
  selectProviderOutputSchemaV2
} from "../../packages/contracts/src/provider-output-schema.js";
import { storyTurnOutputSchema, STORY_PARAGRAPH_WIRE_SCHEMA_VERSION } from "../../packages/contracts/src/story-prompt.js";
import { continuityReviewSchema } from "../../packages/contracts/src/story-continuity-review.js";
import { sha256, stableStringify } from "../../packages/domain/src/text.js";
import { buildContinuityReviewInput, validateContinuityReview } from "../../packages/story-engine/src/continuity-review.js";
import { parseStoryOutput } from "../../packages/story-engine/src/output.js";
import { parseChoiceRepair } from "../../packages/story-engine/src/story-only-output.js";
import { getProviderOutputSchema } from "../../packages/story-engine/src/provider-output-schema.js";
import { makeStructuredOutputStory, structuredOutputFactId, validChoiceRepair, validContinuityReview } from "../fixtures/generation-validation/structured-output-cases.js";

function validateWire(operation: "story" | "choices" | "continuity_review", value: unknown): boolean {
  const validate = new Ajv({ strict: false, allErrors: true }).compile(getProviderOutputSchema(operation).schema);
  return validate(value);
}

describe("provider output schema registry", () => {
  it("accepts the complete native story wire object and preserves arbitrary tracker JSON", () => {
    const trackers = [{
      name: "Trust", value: "wary", metadata: { source: "conversation", history: [null, true, 2, { note: "guarded" }] }
    }];
    const story = makeStructuredOutputStory({ tracker_updates: trackers });

    expect(validateWire("story", story)).toBe(true);
    expect(storyTurnOutputSchema.parse(story).tracker_updates).toEqual(trackers);
    expect(parseStoryOutput(JSON.stringify(story))).toMatchObject({ ok: true, story: { tracker_updates: trackers } });
    expect(getProviderOutputSchema("story").requiresOpenTrackerObjects).toBe(true);
  });

  it.each([
    ["object-valued canonical facts", makeStructuredOutputStory({ canonical_facts: [{ content: "A fact." }] })],
    ["missing replacement fields", (() => { const story = makeStructuredOutputStory(); delete (story as Record<string, unknown>).scratchpad; return story; })()],
    ["wrong delta array", makeStructuredOutputStory({ canonical_fact_updates: "not an array" })],
    ["three choices", makeStructuredOutputStory({ choices: ["One.", "Two.", "Three."] })],
    ["five choices", makeStructuredOutputStory({ choices: ["One.", "Two.", "Three.", "Four.", "Five."] })],
    ["nonempty superseded facts", makeStructuredOutputStory({ superseded_facts: ["Old fact."] })],
    ["malformed supersession id", makeStructuredOutputStory({ canonical_fact_updates: [{ content: "A fact.", supersedes_fact_ids: ["not-a-uuid"] }] })],
    ["501 open threads", makeStructuredOutputStory({ open_threads: Array.from({ length: 501 }, () => "Resolve the observatory mystery.") })]
  ])("rejects %s at the provider wire boundary", (_name, story) => {
    expect(validateWire("story", story)).toBe(false);
  });

  it("accepts empty replacements and empty deltas at the provider wire boundary", () => {
    expect(validateWire("story", makeStructuredOutputStory({ scratchpad: "", continuity_summary: "", canonical_facts: [], superseded_facts: [], canonical_fact_updates: [], open_threads: [] }))).toBe(true);
  });

  it.each([
    ["v4", "11111111-1111-4111-8111-111111111111", true],
    ["v7", "11111111-1111-7111-8111-111111111111", true],
    ["nil", "00000000-0000-0000-0000-000000000000", true],
    ["max", "ffffffff-ffff-ffff-ffff-ffffffffffff", true],
    ["invalid version", "11111111-1111-0111-8111-111111111111", false],
    ["invalid variant", "11111111-1111-4111-c111-111111111111", false]
  ])("matches the canonical fact UUID contract for %s", (_name, id, expected) => {
    const story = makeStructuredOutputStory({ canonical_fact_updates: [{ content: "The lantern changed.", supersedes_fact_ids: [id] }] });
    expect(storyTurnOutputSchema.safeParse(story).success).toBe(expected);
    expect(validateWire("story", story)).toBe(expected);
  });

  it("keeps operations separate from a complete story", () => {
    const story = makeStructuredOutputStory();
    expect(validateWire("choices", validChoiceRepair)).toBe(true);
    expect(() => parseChoiceRepair(JSON.stringify(validChoiceRepair))).not.toThrow();
    expect(validateWire("choices", story)).toBe(false);
    expect(validateWire("continuity_review", validContinuityReview)).toBe(true);
    expect(validateWire("continuity_review", story)).toBe(false);
  });

  it("leaves reference authority to semantic continuity review after JSON Schema accepts syntax", () => {
    const response = {
      version: "story-continuity-review-v1",
      verdict: "conflict",
      findings: [{
        kind: "contradiction", category: "location", severity: "contradiction",
        basis: { kind: "source", evidenceId: "a".repeat(64), quote: "Quay" },
        output: { path: "/narration", start: 0, end: 4, quote: "Mira" }, explanation: "The locations conflict."
      }]
    };
    expect(validateWire("continuity_review", response)).toBe(true);
    expect(validateContinuityReview({
      evidence: [{ id: "b".repeat(64), content: "Mira waits at the quay.", required: true, role: "source" }],
      requiredEvidenceIds: ["b".repeat(64)], direction: "Continue the scene.",
      draft: makeStructuredOutputStory(), draftHash: "c".repeat(64), projectionHash: "d".repeat(64), evidenceHash: "e".repeat(64), excluded: { scratchpad: 1, trackerFields: 0 }
    }, response)).toEqual({ version: "story-continuity-review-v1", verdict: "uncertain", findings: [] });
  });

  it("keeps source, candidate, and omission review unions syntactic while semantic review checks their references", () => {
    const draft = makeStructuredOutputStory();
    const input = buildContinuityReviewInput({
      evidence: [{ id: "a".repeat(64), content: "Quay", required: true, role: "source" }],
      requiredEvidenceIds: ["a".repeat(64)], direction: "Continue the scene.", draft
    });
    const source = { version: "story-continuity-review-v1", verdict: "conflict", findings: [{
      kind: "contradiction", category: "location", severity: "contradiction",
      basis: { kind: "source", evidenceId: "a".repeat(64), quote: "Quay" },
      output: { path: "/narration", start: 0, end: 4, quote: "Mira" }, explanation: "The locations conflict."
    }] };
    const candidate = { ...source, findings: [{ ...source.findings[0], basis: {
      kind: "candidate", draftHash: input.draftHash,
      location: { path: "/narration", start: 0, end: 4, quote: "Mira" }
    } }] };
    const omission = { version: "story-continuity-review-v1", verdict: "pass", findings: [{
      kind: "omission", category: "thread_loss", severity: "warning", expectedEvidenceIds: ["a".repeat(64)], outputPath: "/open_threads", explanation: "An unresolved thread was omitted."
    }] };
    for (const response of [source, candidate, omission]) {
      expect(validateWire("continuity_review", response)).toBe(true);
      expect(validateContinuityReview(input, response)).toEqual(response);
    }
  });

  it("preserves whitespace-bearing evidence quotations exactly as the continuity contract does", () => {
    const review = {
      version: "story-continuity-review-v1", verdict: "conflict", findings: [{
        kind: "contradiction", category: "location", severity: "contradiction",
        basis: { kind: "source", evidenceId: "a".repeat(64), quote: " Quay " },
        output: { path: "/narration", start: 0, end: 6, quote: " Mira " }, explanation: " Exact quotation. "
      }]
    };
    expect(validateWire("continuity_review", review)).toBe(true);
    expect(continuityReviewSchema.parse(review)).toEqual(review);
  });

  it("leaves continuity cross-field verdict and quote-offset constraints to the semantic contract", () => {
    const contradiction = {
      kind: "contradiction", category: "location", severity: "contradiction",
      basis: { kind: "source", evidenceId: "a".repeat(64), quote: "Quay" },
      output: { path: "/narration", start: 4, end: 4, quote: "Mira" }, explanation: "The locations conflict."
    };
    const malformedLocation = { version: "story-continuity-review-v1", verdict: "conflict", findings: [contradiction] };
    const passWithContradiction = { ...malformedLocation, verdict: "pass" };
    const conflictWithoutContradiction = { version: "story-continuity-review-v1", verdict: "conflict", findings: [] };

    for (const response of [malformedLocation, passWithContradiction, conflictWithoutContradiction]) {
      expect(validateWire("continuity_review", response)).toBe(true);
      expect(continuityReviewSchema.safeParse(response).success).toBe(false);
    }
  });

  it("keeps UTF-16 length authority in the continuity contract when JSON Schema counts Unicode code points", () => {
    const astralQuote = "😀".repeat(1000);
    const response = {
      version: "story-continuity-review-v1", verdict: "conflict", findings: [{
        kind: "contradiction", category: "location", severity: "contradiction",
        basis: { kind: "source", evidenceId: "a".repeat(64), quote: "Quay" },
        output: { path: "/narration", start: 0, end: astralQuote.length, quote: astralQuote }, explanation: "The locations conflict."
      }]
    };
    expect(validateWire("continuity_review", response)).toBe(true);
    expect(continuityReviewSchema.safeParse(response).success).toBe(false);
  });

  it("uses immutable versioned schema content and a stable content hash", () => {
    const story = getProviderOutputSchema("story");
    expect(story.version).toBe("story-native-v1");
    expect(story.schemaHash).toBe(sha256(stableStringify(story.schema)));
    expect(Object.isFrozen(story)).toBe(true);
    expect(Object.isFrozen(story.schema)).toBe(true);
    expect(() => { (story.schema as Record<string, unknown>).type = "array"; }).toThrow(TypeError);
    expect(story.schemaHash).toBe(sha256(stableStringify(story.schema)));
    expect(getProviderOutputSchema("choices").version).toBe("choices-v1");
    expect(getProviderOutputSchema("continuity_review").version).toBe("continuity-review-v1");
    expect(structuredOutputFactId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("versioned v2 schema catalog", () => {
  it("returns the preferred version by default and every registered version by name", () => {
    const versions = providerOutputSchemaVersionsV2("story");
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(getProviderOutputSchemaV2("story")).toBe(versions[0]);
    for (const entry of versions) expect(getProviderOutputSchemaV2("story", entry.version)).toBe(entry);
  });

  it("keeps story-native-v2 addressable with its original hash", () => {
    const legacy = findProviderOutputSchemaV2("story", "story-native-v2");
    expect(legacy?.name).toBe("infinite_quest_story_native_v2");
    // Pinned to the literal hash (verified unchanged pre/post branch), not just
    // a hex-shaped regex, so a schema-changing regression fails this test.
    expect(legacy?.schemaHash).toBe("10765575fa1c47721ba4f72f81d918edc2dbf6df288e952f84ae4f485bcc55d7");
  });

  it("rejects an unknown version", () => {
    expect(findProviderOutputSchemaV2("story", "story-native-v999")).toBeUndefined();
    expect(() => getProviderOutputSchemaV2("story", "story-native-v999")).toThrow(/Unknown story schema version/);
  });

  it("resolves a registered version from its schema hash for persisted evidence that only carries a hash", () => {
    const preferred = getProviderOutputSchemaV2("story");
    expect(findProviderOutputSchemaV2ByHash("story", preferred.schemaHash)).toBe(preferred);
    expect(findProviderOutputSchemaV2ByHash("story", "f".repeat(64))).toBeUndefined();
  });
});

describe("story-native-v3 paragraph wire schema", () => {
  const v3 = getProviderOutputSchemaV2("story", STORY_PARAGRAPH_WIRE_SCHEMA_VERSION);
  const validate = new Ajv({ strict: false, allErrors: true }).compile(v3.schema);
  const base = makeStructuredOutputStory();
  const { narration: _narration, ...withoutNarration } = base;

  it("is preferred and requires narration_paragraphs instead of narration", () => {
    expect(getProviderOutputSchemaV2("story").version).toBe(STORY_PARAGRAPH_WIRE_SCHEMA_VERSION);
    expect(validate({ ...withoutNarration, narration_paragraphs: ["“Stay,” Mara says.", "You nod."] })).toBe(true);
    expect(validate(base)).toBe(false);
    expect(validate({ ...withoutNarration, narration_paragraphs: [] })).toBe(false);
  });

  it("carries no prose pattern on paragraph items", () => {
    const items = (v3.schema as any).properties.narration_paragraphs.items;
    expect(items.pattern).toBeUndefined();
    expect(items.minLength).toBe(1);
  });

  it("selects the first acceptable version", () => {
    expect(selectProviderOutputSchemaV2("story", () => true)?.version).toBe("story-native-v3");
    expect(selectProviderOutputSchemaV2("story", (schema) => schema.version === "story-native-v2")?.version).toBe("story-native-v2");
    expect(selectProviderOutputSchemaV2("story", () => false)).toBeNull();
  });
});
