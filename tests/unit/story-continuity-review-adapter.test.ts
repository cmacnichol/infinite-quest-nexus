import { PROMPT_TEMPLATE_CATALOG, CONTINUITY_REVIEW_PROMPT_CATALOG } from "../../packages/contracts/src/prompt-library.js";
import { describe, expect, it, vi } from "vitest";
import { prepareContinuityRepair, prepareContinuityReview, executePreparedContinuityReview } from "../../services/runtime/src/story-continuity-review-adapter.js";
import { createStoryEvidence, generationEvidenceManifestHash } from "../../packages/application/src/memory/generation-context.js";
import { storyTurnOutputSchema } from "../../packages/contracts/src/story-prompt.js";
import { sha256 } from "../../packages/domain/src/text.js";
import { serializeProviderRequest } from "../../packages/story-engine/src/provider-request.js";
const requestHash = sha256("producing-request");
const entry = createStoryEvidence({ source: { kind: "state_edit", id: "state", revision: "1", turnNumber: 1 }, semanticRole: "current_continuity", rank: 0, selectionGroup: "protected", sourcePath: "/text", normalizationVersion: "fiction-safe-json-v1", form: "complete", spans: [], canonicalFactId: null }, { text: "Mira waits at the lighthouse." });
const body = { version: "generation-evidence-v1" as const, attemptId: "00000000-0000-4000-8000-000000000001", producingRequestHash: requestHash, entries: [entry], requiredReviewEvidenceIds: [entry.id] };
const manifest = { ...body, manifestHash: generationEvidenceManifestHash(body) };
const draft = storyTurnOutputSchema.parse({ narration: "Mira waits.", choices: ["Wait", "Go", "Look", "Listen"], custom_action_suggestion: "Wait", scratchpad: "private secret", tracker_updates: [], image_prompt: "Lighthouse", continuity_summary: "Mira waits.", canonical_facts: [], canonical_fact_updates: [], superseded_facts: [], open_threads: [] });
const provider = { id: "p", name: "Fake", providerRole: "text", providerType: "openai_compatible", model: "test", contextWindowTokens: 32000, maxOutputTokens: 1000, temperature: 0, requestTimeoutMs: 1000, configuration: {}, execute: vi.fn() } as const;
const promptSnapshot = { version: 2, templates: Object.fromEntries(Object.entries(PROMPT_TEMPLATE_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped" }])), continuityReview: Object.fromEntries(Object.entries(CONTINUITY_REVIEW_PROMPT_CATALOG).map(([key, value]) => [key, { content: value.defaultContent, hash: sha256(value.defaultContent), source: "shipped", protocolIdentity: value.protocolIdentity }])) };
const prepare = (overrides = {}) => prepareContinuityReview({ provider, manifest, producingRequestHash: requestHash, promptSnapshot, reviewMode: "observe", direction: "Wait", draft, ...overrides });
describe("exact continuity review provider request", () => {
  it("measures the same complete transport body and excludes private scratchpad", () => {
    const prepared = prepare();
    expect(prepared.body).toBe(serializeProviderRequest({ ...provider, baseUrl: "" }, prepared.request).body);
    expect(prepared.body).not.toContain("private secret");
    expect(prepared.body).toContain(entry.content);
    expect(prepared.request).not.toHaveProperty("previousResponseId");
    expect(prepared.request.responseFormatFallback).toBe("forbid");
  });
  it("rejects missing manifest entries, changed producing request and overflow before dispatch", () => {
    expect(() => prepare({ manifest: { ...manifest, entries: [] } })).toThrow();
    expect(() => prepare({ producingRequestHash: "a".repeat(64) })).toThrow();
    expect(() => prepare({ effectiveContextWindowTokens: 1100 })).toThrow(/continuity_review_unavailable/);
    expect(provider.execute).not.toHaveBeenCalled();
  });
  it("requires the frozen prompt pair and preserves manifest requiredness", () => {
    expect(() => prepare({ promptSnapshot: { ...promptSnapshot, continuityReview: null } })).toThrow();
    expect(() => prepare({ promptSnapshot: { ...promptSnapshot, continuityReview: { ...promptSnapshot.continuityReview, review: { ...promptSnapshot.continuityReview.review, protocolIdentity: "different" } } } })).toThrow();
    const optional = { ...body, requiredReviewEvidenceIds: [] };
    expect(prepare({ manifest: { ...optional, manifestHash: generationEvidenceManifestHash(optional) } }).input.requiredEvidenceIds).toEqual([]);
  });
  it("requires actual producing review request identity and parses a strict result", async () => {
    const prepared = prepare();
    const result: any = { content: JSON.stringify({ version: "story-continuity-review-v1", verdict: "pass", findings: [] }), outputLimited: false,
      preparedRequest: { body: prepared.body, payloadHash: sha256(prepared.body) } };
    const execute = vi.fn(async () => result);
    expect((await executePreparedContinuityReview({ ...provider, execute }, prepared)).review.verdict).toBe("pass");
    expect(execute).toHaveBeenCalledOnce();
    result.preparedRequest.payloadHash = "f".repeat(64);
    await expect(executePreparedContinuityReview({ ...provider, execute }, prepared)).rejects.toThrow(/continuity_review_unavailable/);
  });
  it("prepares a complete self-contained repair without private scratchpad or a continuation", () => {
    const prepared = prepareContinuityRepair({ provider, manifest, promptSnapshot, direction: "Wait", rejectedDraft: draft,
      findings: [{ code: "conflict", evidence_ids: [entry.id] }] });
    expect(prepared.body).toContain(entry.content);
    expect(prepared.body).toContain("conflict");
    expect(prepared.body).not.toContain("private secret");
    expect(prepared.request.previousResponseId).toBeUndefined();
    expect(prepared.request.responseFormatFallback).toBe("forbid");
    expect(prepared.requiredEvidenceIds).toEqual([entry.id]);
  });
  it("replans only dispensable optional repair evidence while preserving the conflict and original main boundary", () => {
    const optional = createStoryEvidence({ source: { kind: "turn", id: "old-turn", revision: "1", turnNumber: 1 }, sourcePath: "/text", semanticRole: "accepted_narration", normalizationVersion: "fiction-safe-json-v1", form: "complete", spans: [], selectionGroup: "retrieved", rank: 1, canonicalFactId: null }, { text: "An old unrelated passage. ".repeat(5000) });
    const full = { ...body, entries: [entry, optional] }; const expanded = { ...full, manifestHash: generationEvidenceManifestHash(full) };
    const originalMain = { ...draft, narration: "The original main waits." };
    const args = { provider, manifest: expanded, promptSnapshot, direction: "Wait", rejectedDraft: draft, originalMain, scope: "main" as const, effectiveContextWindowTokens: 5000,
      findings: [{ kind: "contradiction", basis: { kind: "source", evidenceId: entry.id } }] };
    const prepared = prepareContinuityRepair(args);
    expect(prepared.body).not.toContain(optional.content); expect(prepared.body).toContain(entry.content);
    expect(prepared.body).toContain("original_main"); expect(prepared.body).toContain(originalMain.narration);
    expect(prepared.omittedEvidenceIds).toEqual([optional.id]);
    expect(() => prepareContinuityRepair({ ...args, findings: [{ kind: "contradiction", basis: { kind: "source", evidenceId: optional.id } }] })).toThrow(/continuity_review_unavailable/);
  });

});
