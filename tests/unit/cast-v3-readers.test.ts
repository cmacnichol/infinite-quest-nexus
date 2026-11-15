import { expect, it } from "vitest";
import { CAST_V3_STORY_MEMORY_PROMPT_PROTOCOL_VERSION as prompt, CAST_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION as cast, HISTORY_V3_STORY_MEMORY_CONTEXT_POLICY_VERSION as history, CAST_V2_STORY_MEMORY_PROMPT_PROTOCOL_VERSION as oldPrompt, CAST_V2_STORY_MEMORY_CONTEXT_POLICY_VERSION as oldCast, CAST_V3_STORY_AUTHORITY_CONTRACT, storyMemoryMandatoryContract } from "../../packages/contracts/src/story-prompt.js";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash, storyMemoryPolicySnapshotSchema, isCastV2ContextProtocol, isHistoryCoverageContextProtocol } from "../../packages/contracts/src/story-memory-policy.js";
import { castContextNotice } from "../../packages/domain/src/campaign-cast-context.js";
it("reads only matching V3 protocol pairs and preserves V2", () => {
 const policy = defaultStoryMemoryPolicy("r2");
 const snapshot = { policy, policyHash: storyMemoryPolicyHash(policy), providerConfigurationFingerprint: "a".repeat(64), castContext: true, castDiscoveryEnabled: true, promptProtocol: prompt, contextProtocol: cast };
 for (const contextProtocol of [cast, history]) expect(storyMemoryPolicySnapshotSchema.safeParse({ ...snapshot, contextProtocol }).success).toBe(true);
 expect(storyMemoryPolicySnapshotSchema.safeParse({ ...snapshot, promptProtocol: oldPrompt }).success).toBe(false);
 expect(storyMemoryPolicySnapshotSchema.safeParse({ ...snapshot, contextProtocol: oldCast }).success).toBe(false);
 expect(storyMemoryPolicySnapshotSchema.safeParse({ ...snapshot, contextProtocol: oldCast, promptProtocol: oldPrompt }).success).toBe(true);
 expect(isCastV2ContextProtocol(history)).toBe(true); expect(isHistoryCoverageContextProtocol(history)).toBe(true);
 expect(storyMemoryMandatoryContract(prompt)).toContain(CAST_V3_STORY_AUTHORITY_CONTRACT);
 expect(CAST_V3_STORY_AUTHORITY_CONTRACT).not.toContain("User field overrides");
 expect(castContextNotice(cast, "current")).toBe("User corrections are portrayal authority from their effective turn. User state edits are authority until later story evidence. Older conflicting facts remain historical evidence.");
 expect(castContextNotice(cast, "off")).toBe("Character discovery is off. User corrections guide portrayal; state edits yield to later recorded story evidence. Observations are dated last-known state; use accepted history for later events.");
 expect(castContextNotice(cast, "failed")).toBe("Tracking is incomplete. User corrections remain portrayal authority; user state edits are authority until later recorded story evidence. Other observations are dated, lower-authority last-known state; use accepted history for intervening events.");
 expect(castContextNotice(cast, "failed")).toBe(castContextNotice(cast, "pending"));
 expect(castContextNotice(oldCast, "off")).toBe("Character discovery is off. Observations are dated, lower-authority last-known state; use accepted history for later events.");
});

it("gives newer observations authority over state edits in the complete V3 contract while freezing V2", () => {
 const v3 = storyMemoryMandatoryContract(prompt);
 expect(CAST_V3_STORY_AUTHORITY_CONTRACT).toBe("Campaign cast authority: use only the selected cast records and supplied evidence. User corrections govern current portrayal from their effective turn, including intentional empty values; user state edits govern until later story evidence. Older conflicting facts remain dated historical evidence; do not restore them as current attributes or treat compliance with a correction as a contradiction. Immutable world rules still apply; unresolved conflicts require uncertainty. Cast coverage is bounded: when tracking is incomplete, use accepted recent history for intervening events, and never infer that an omitted character or field is absent. Aliases identify the supplied stable character only when unambiguous. Prose relationship guidance is not a structured relationship record. Authored fields and deliberate campaign edits guide portrayal. Older conflicting observations are lower-authority dated evidence. When discovery is off, use last-known observations with accepted history; during a tracking gap, an authored goal takes precedence over an older observed goal unless a user override applies. An authored appearance summary and an observed appearance are distinct.");
 expect(v3).toContain("Older conflicting observations are lower-authority dated evidence.");
 expect(v3).not.toContain("Observations are lower-authority dated evidence.");
 expect(storyMemoryMandatoryContract(oldPrompt)).toContain("Observations are lower-authority dated evidence.");
});
