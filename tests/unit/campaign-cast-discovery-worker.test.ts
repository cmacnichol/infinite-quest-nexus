import { describe, expect, it, vi } from "vitest";
import { runCastDiscoveryOnce, type CastDiscoveryClaim } from "../../packages/application/src/campaign-cast/discovery.js";
import { deriveTextExecutionPlan, textExecutionRouteBasisHash } from "../../packages/contracts/src/text-execution-plan.js";
import { CAST_DISCOVERY_SYSTEM_PROMPT } from "../../packages/contracts/src/prompt-library.js";
import { buildCastDiscoverySource } from "../../packages/domain/src/campaign-cast-discovery.js";

const id = "11111111-1111-4111-8111-111111111111";
const output = { version: 1 as const, characters: [] };
function fixture(checkpoint = false) {
  const scope = { ownerUserId: id, campaignId: id };
  const basis = { version: 2 as const, selection: { kind: "model" as const, modelId: "fixture" }, preset: null,
    candidates: [{ modelId: "fixture", providerPolicy: {}, contextWindowTokens: 8000, maxOutputTokens: 2000 }],
    presetSystemPrompt: "", parameters: {}, endpointReference: "fixture", credentialReference: id,
    profileRevision: "fixture", authorityRevision: "fixture", requestTimeoutMs: 30000, protocolVersion: "cast-discovery-v1", routeBasisHash: "0".repeat(64) };
  const claim: CastDiscoveryClaim = { id, scope, chunkOrdinal: 0, chunkCount: 1, attempt: 1, leaseToken: id,
    output: checkpoint ? output : null, identities: { revision: 0, characters: [], worldVersionId: id, worldCharacters: [] },
    source: buildCastDiscoverySource({ scope, turnId: id, turnNumber: 1, narrationRevision: 0, timelineRevision: 0, narration: "Mara waits." }),
    execution: { providerProfileId: id, plan: deriveTextExecutionPlan({ ...basis, routeBasisHash: textExecutionRouteBasisHash(basis) }, CAST_DISCOVERY_SYSTEM_PROMPT) } };
  const repository = { claim: vi.fn(async () => claim as CastDiscoveryClaim | null), checkpoint: vi.fn(async () => true),
    fail: vi.fn(async () => true), publish: vi.fn(async () => "complete" as const) };
  const extractor = { extract: vi.fn(async () => output as unknown) };
  return { claim, repository, extractor };
}

describe("discovery worker application flow", () => {
  it("checkpoints validated extraction before publication", async () => {
    const f = fixture();
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("complete");
    expect(f.repository.checkpoint).toHaveBeenCalledWith(f.claim, output);
    expect(f.extractor.extract.mock.invocationCallOrder[0]).toBeLessThan(f.repository.checkpoint.mock.invocationCallOrder[0]!);
    expect(f.repository.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(f.repository.publish.mock.invocationCallOrder[0]!);
  });
  it("publishes an existing checkpoint without another provider call", async () => {
    const f = fixture(true);
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("complete");
    expect(f.extractor.extract).not.toHaveBeenCalled(); expect(f.repository.checkpoint).not.toHaveBeenCalled();
  });
  it("does no work without an eligible claim", async () => {
    const f = fixture(); f.repository.claim.mockResolvedValue(null);
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("idle");
    expect(f.extractor.extract).not.toHaveBeenCalled();
  });
  it("rejects malformed extraction and records a sanitized failure without publishing", async () => {
    const f = fixture(); f.extractor.extract.mockResolvedValue({ secret: "untrusted" });
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("failed");
    expect(f.repository.fail).toHaveBeenCalledWith(f.claim, "invalid_output");
    expect(f.repository.publish).not.toHaveBeenCalled(); expect(f.repository.checkpoint).not.toHaveBeenCalled();
  });
  it("does not publish after losing its checkpoint lease", async () => {
    const f = fixture(); f.repository.checkpoint.mockResolvedValue(false);
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("lost_lease");
    expect(f.repository.publish).not.toHaveBeenCalled();
  });
  it("recovers an uncertain checkpoint commit without turning it into a provider retry", async () => {
    const f = fixture();
    f.repository.checkpoint.mockImplementation(async () => {
      f.claim.output = output;
      throw new Error("connection lost after commit");
    });
    expect(await runCastDiscoveryOnce({ ...f, workerId: "first" })).toBe("checkpoint_failed");
    expect(f.repository.fail).not.toHaveBeenCalled(); expect(f.repository.publish).not.toHaveBeenCalled();
    expect(await runCastDiscoveryOnce({ ...f, workerId: "recovered" })).toBe("complete");
    expect(f.extractor.extract).toHaveBeenCalledTimes(1);
  });
  it("retains a checkpoint after publication failure for a later claim", async () => {
    const f = fixture(true); f.repository.publish.mockRejectedValue(new Error("private diagnostic"));
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("publication_failed");
    expect(f.repository.fail).not.toHaveBeenCalled(); expect(f.extractor.extract).not.toHaveBeenCalled();
  });
  it("sanitizes provider errors and leaves retry policy with the durable repository", async () => {
    const f = fixture(); f.extractor.extract.mockRejectedValue(new Error("private provider output"));
    expect(await runCastDiscoveryOnce({ ...f, workerId: "worker" })).toBe("failed");
    expect(f.repository.fail).toHaveBeenCalledWith(f.claim, "provider_failed");
    expect(f.extractor.extract).toHaveBeenCalledTimes(1);
  });
});
