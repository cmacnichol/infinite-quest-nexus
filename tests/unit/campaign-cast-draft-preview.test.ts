import { describe, expect, it, vi } from "vitest";
import { createCastDraftPreview } from "../../services/runtime/src/cast-draft-preview.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111", campaignId = "22222222-2222-4222-8222-222222222222", id = "33333333-3333-4333-8333-333333333333", evidenceId = "44444444-4444-4444-8444-444444444444";
const scope = { ownerUserId, campaignId }, boundary = { turnNumber: 1, timelineRevision: 0 };
const request = { expectedCastRevision: 1, expectedCharacterRevision: 1, expectedBoundary: boundary };
const evidence = { evidenceId, characterId: id, turnId: "55555555-5555-4555-8555-555555555555", turnNumber: 1, narrationRevision: 0, sourceHash: "a".repeat(64), paragraphId: "p1", start: 0, end: 17, quote: "Mara has blue eyes." };
const character = { id, name: "Mara", aliases: [], origin: { kind: "manual" }, profile: {}, revision: 1, pinned: false, ignored: false, firstObservedTurn: 0, lastObservedTurn: 1 };
const result = (content: unknown) => ({ content: JSON.stringify(content), responseId: "x", finishReason: "stop", outputLimited: false, modelInstanceId: "m", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, reportedCost: null, rawMetadata: {} });

describe("cast draft preview", () => {
  it("makes no provider request without eligible accepted evidence", async () => {
    const execute = vi.fn();
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character, boundary, evidence: [], observedPaths: [] }) };
    const preview = createCastDraftPreview({} as never, repo as never, { execution: { text: execute } } as never);
    expect(await preview(scope, id, request)).toMatchObject({ proposals: [], evidence: [] });
    expect(execute).not.toHaveBeenCalled();
  });
  it("returns only subject-attributed supported values and fences, dropping unknown citations", async () => {
    const execute = vi.fn().mockResolvedValue(result({ proposals: [
      { path: "appearance.description", value: "blue eyes", evidenceIds: [evidenceId] },
      { path: "story.role", value: "guard", evidenceIds: ["66666666-6666-4666-8666-666666666666"] }
    ] }));
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character, boundary, evidence: [evidence], observedPaths: [] }) };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ text_provider_profile_id: id, content: { world: {} } }] }) };
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: id, model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    const preview = createCastDraftPreview(pool as never, repo as never, providers as never);
    const value = await preview(scope, id, request);
    expect(value.proposals).toEqual([{ path: "appearance.description", value: "blue eyes", evidenceIds: [evidenceId], draftEvidenceFence: { path: "appearance.description", value: "blue eyes", evidence: [evidence] } }]);
    expect(value.omitted).toEqual([{ path: "story.role", reason: "unsupported_or_unavailable" }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(providers.resolution.resolveDirect).toHaveBeenCalledWith({ ownerUserId, providerRole: "text", selectedProviderProfileId: id });
    const sent = JSON.stringify(execute.mock.calls[0]);
    expect(sent).not.toContain("text_provider_profile_id");
  });
  it("rejects an entire malformed response without returning partial proposals", async () => {
    const execute = vi.fn().mockResolvedValue(result({ proposals: [{ path: "appearance.description", value: 12, evidenceIds: [evidenceId] }] }));
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character, boundary, evidence: [evidence], observedPaths: [] }) };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ content: { world: {} } }] }) };
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: id, model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    await expect(createCastDraftPreview(pool as never, repo as never, providers as never)(scope, id, request)).rejects.toMatchObject({ code: "cast_discovery_unavailable" });
  });
  it("withholds observed blank fields and creative guidance with citations", async () => {
    const execute = vi.fn().mockResolvedValue(result({ proposals: [
      { path: "story.role", value: "kind", evidenceIds: [evidenceId] },
      { path: "story.otherGuidance", value: "a mystery", evidenceIds: [evidenceId] }
    ] }));
    const subject = { ...character, campaignProfile: { story: {} } };
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character: subject, boundary, evidence: [evidence], observedPaths: ["story.role"] }) };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ content: { world: {} } }] }) };
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: id, model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    const value = await createCastDraftPreview(pool as never, repo as never, providers as never)(scope, id, request);
    expect(value.proposals).toEqual([]);
    expect(value.omitted).toHaveLength(2);
  });
  it("does not retransmit rejected private model output during repair", async () => {
    const execute = vi.fn().mockResolvedValueOnce(result({ proposals: [], secret: "<think>private canary</think>" }))
      .mockResolvedValueOnce(result({ proposals: [] }));
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character, boundary, evidence: [evidence], observedPaths: [] }) };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ content: { world: {} } }] }) };
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: id, model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    await createCastDraftPreview(pool as never, repo as never, providers as never)(scope, id, request);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[1])).not.toContain("private canary");
  });
  it("projects bounded effective authored fiction and excludes private extensions and reasoning", async () => {
    const execute = vi.fn().mockResolvedValue(result({ proposals: [] }));
    const subject = { ...character, profile: { "story.role": "Campaign guide" }, campaignProfile: { story: { role: "Old guide", background: "A sailor. <think>hidden canary</think>" }, secretExtension: "private extension canary" } };
    const repo = { draftPreviewContext: vi.fn().mockResolvedValue({ character: subject, boundary, evidence: [evidence], observedPaths: [] }) };
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ content: { world: { premise: "An island. <analysis>world canary</analysis>" }, secret: "private world canary" } }] }) };
    const providers = { resolution: { resolveDirect: vi.fn().mockResolvedValue({ status: "resolved", providerProfileId: id, model: "m" }) }, execution: { text: vi.fn().mockResolvedValue({ execute, model: "m" }) } };
    await createCastDraftPreview(pool as never, repo as never, providers as never)(scope, id, request);
    const sent = JSON.stringify(execute.mock.calls[0]);
    expect(sent).toContain("Campaign guide");
    expect(sent).toContain("A sailor.");
    expect(sent).not.toMatch(/hidden canary|private extension canary|world canary|private world canary|Old guide/);
  });
});
