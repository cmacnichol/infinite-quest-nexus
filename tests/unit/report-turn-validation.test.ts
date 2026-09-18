import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultStoryMemoryPolicy, storyMemoryPolicyHash } from "../../packages/contracts/src/story-memory-policy.js";
import { storyPromptCompatibilityIdentity } from "../../packages/contracts/src/story-prompt.js";
import { generationExecutionProtocolIdentity, generationPolicyIdentity, storyOnlyPromptSnapshot } from "../../packages/story-engine/src/index.js";
import { parseTurnValidationReportOptions, readTurnValidationReport } from "../../scripts/report-turn-validation.js";

const buildIdentityEnvironmentKeys = ["NEXUS_BUILD_COMMIT", "GIT_SHA", "BUILD_SHA"] as const;
type BuildIdentityEnvironmentKey = typeof buildIdentityEnvironmentKeys[number];
const originalBuildIdentityEnvironment = Object.fromEntries(buildIdentityEnvironmentKeys.map((key) => [key, process.env[key]])) as Record<BuildIdentityEnvironmentKey, string | undefined>;

function setBuildIdentityEnvironment(values: Partial<Record<BuildIdentityEnvironmentKey, string | undefined>>) {
  for (const key of buildIdentityEnvironmentKeys) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function frozenStoryMemoryPolicy(promptProtocol: "story-v14-continuity-context" | "story-v15-canonical-fact-format") {
  const policy = defaultStoryMemoryPolicy("r3");
  return {
    policy,
    policyHash: storyMemoryPolicyHash(policy),
    contextProtocol: "current-continuity-v3",
    promptProtocol,
    providerConfigurationFingerprint: "a".repeat(64)
  };
}

function storyOnlyPolicy() {
  return {
    version: 1 as const,
    playMode: "story_only" as const,
    turnControlStyle: "flexible_scene" as const,
    protocolVersion: "story-only-v1" as const,
    prompts: storyOnlyPromptSnapshot()
  };
}

describe("turn validation report", () => {
  afterEach(() => setBuildIdentityEnvironment(originalBuildIdentityEnvironment));

  it.each([
    [{ NEXUS_BUILD_COMMIT: "deployed-commit", GIT_SHA: "legacy-git-sha", BUILD_SHA: "legacy-build-sha" }, "deployed-commit"],
    [{ GIT_SHA: "legacy-git-sha", BUILD_SHA: "legacy-build-sha" }, "legacy-git-sha"],
    [{ BUILD_SHA: "legacy-build-sha" }, "legacy-build-sha"],
    [{}, "unknown"]
  ] as const)("uses build identity %s", async (environment, expectedBuildIdentity) => {
    setBuildIdentityEnvironment(environment);
    const query = vi.fn(async () => ({ rows: [] }));

    const report = await readTurnValidationReport({ query } as any, { limit: 50, since: null, format: "json" });

    expect(report.buildIdentity).toBe(expectedBuildIdentity);
  });

  it("replaces an unsafe deployed build commit with unknown", async () => {
    setBuildIdentityEnvironment({ NEXUS_BUILD_COMMIT: "deployed\nsecret", GIT_SHA: "legacy-git-sha" });
    const query = vi.fn(async () => ({ rows: [] }));

    const report = await readTurnValidationReport({ query } as any, { limit: 50, since: null, format: "json" });

    expect(report.buildIdentity).toBe("unknown");
  });

  it("rejects unsafe report limits and non-UTC since values", () => {
    expect(() => parseTurnValidationReportOptions(["--limit", "1001"])).toThrow("--limit must be between 1 and 1000");
    expect(() => parseTurnValidationReportOptions(["--since", "2026-09-18"])).toThrow("--since must be a UTC timestamp");
    expect(parseTurnValidationReportOptions(["--limit", "50", "--since", "2026-09-18T00:00:00.000Z", "--format", "json"]))
      .toEqual({ limit: 50, since: "2026-09-18T00:00:00.000Z", format: "json" });
  });

  it("uses a read-only transaction, bounded parameterized metadata queries, and rollback", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() };
    const report = await readTurnValidationReport(client as any, { limit: 50, since: null, format: "json" });

    expect(query.mock.calls[0]).toEqual(["BEGIN READ ONLY"]);
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT $2");
    expect(query.mock.calls[1]?.[0]).not.toContain("raw_output");
    expect(query.mock.calls[1]?.[1]).toEqual([null, 50]);
    expect(report.metrics).toEqual(expect.objectContaining({ jobs: 0, initialValid: 0 }));
  });

  it("uses durable completion, output presence, and validation errors rather than response IDs or finish limits", async () => {
    const enrolledV14 = "story-memory-v1|prompt-library-v1-5d636b749d679ddc|legacy";
    const enrolledV15 = "story-memory-v1|prompt-library-v1-dc1b588a0a37f571|legacy";
    const malformedComposite = "story-memory-v1|MODEL_SECRET";
    const nonEnrolledStoryOnlyPolicy = storyOnlyPolicy();
    const oldStoryOnlyProtocol = generationExecutionProtocolIdentity("prompt-library-v1-dc1b588a0a37f571", nonEnrolledStoryOnlyPolicy);
    const jobs = [
      { id: "null-id", status: "completed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: enrolledV14,
        requestedModel: "", errorCode: null, failureDiagnostic: null, contextOptions: { storyMemoryPolicy: frozenStoryMemoryPolicy("story-v14-continuity-context") }, generationPolicy: null },
      { id: "length", status: "recoverable", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: enrolledV15,
        requestedModel: "configured", errorCode: "generation_failed", failureDiagnostic: {
          version: 1, category: "output_incomplete", code: "output_limit", phase: "story_validation", attemptNumber: 1,
          occurredAt: "2026-09-18T00:00:02.000Z", privateMessage: "provider body was cut off"
        }, contextOptions: { storyMemoryPolicy: frozenStoryMemoryPolicy("story-v15-canonical-fact-format") }, generationPolicy: null },
      { id: "invalid", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: oldStoryOnlyProtocol,
        requestedModel: "configured-repair", errorCode: "generation_failed", failureDiagnostic: {
          version: 1, category: "format", code: "invalid_schema", phase: "story_validation", attemptNumber: 1,
          occurredAt: "2026-09-18T00:00:02.000Z", privateMessage: "raw parser detail"
        }, contextOptions: { budgetTokens: 64_000 }, generationPolicy: nonEnrolledStoryOnlyPolicy },
      { id: "incomplete", status: "discarded", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: malformedComposite,
        requestedModel: "configured\nMODEL_SECRET", errorCode: "MODEL_SECRET=raw_provider_code", failureDiagnostic: null, contextOptions: { storyMemoryPolicy: { policy: null } }, generationPolicy: null }
    ];
    const query = vi.fn(async (text: string) => {
      if (text.includes("FROM generation_jobs")) return { rows: jobs };
      if (text.includes("FROM generation_attempts")) return { rows: [
        { jobId: "null-id", attemptNumber: 1, recoveryKind: "initial", providerResponseId: null, completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: [], requestMetadata: { model: "frozen-default-model" }, responseMetadata: { outputLimited: false, modelInstanceId: "returned-null-id" } },
        { jobId: "length", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: true, modelInstanceId: "returned-length" } },
        { jobId: "invalid", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: "2026-09-18T00:00:01.000Z", hasOutput: true, validationErrors: ["canonical_facts missing"], responseMetadata: { outputLimited: false, modelInstanceId: "returned-invalid" } },
        { jobId: "invalid", attemptNumber: 2, recoveryKind: "repair", providerResponseId: "response-repair", completedAt: "2026-09-18T00:00:02.000Z", hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: false, modelInstanceId: "returned-repair" } },
        { jobId: "incomplete", attemptNumber: 1, recoveryKind: "initial", providerResponseId: "response", completedAt: null, hasOutput: true, validationErrors: [], responseMetadata: { outputLimited: false, modelInstanceId: "returned\nMODEL_SECRET" } }
      ] };
      return { rows: [] };
    });

    const report = await readTurnValidationReport({ query } as any, { limit: 50, since: null, format: "json" });
    expect(report.metrics).toMatchObject({ jobsWithInitialResponse: 3, initialValid: 2, initialInvalid: 1, initialUnknown: 1,
      repairResponses: 1, validRepairResponses: 1 });
    expect(report.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: "null-id", finalStatus: "completed", initialOutcome: "valid", configuredModel: "frozen-default-model", actualReturnedModel: "returned-null-id" }),
      expect.objectContaining({ jobId: "length", finalStatus: "recoverable", failureDiagnostic: { code: "output_limit", message: "The provider output was incomplete." } }),
      expect.objectContaining({ jobId: "invalid", finalStatus: "failed", initialOutcome: "invalid", configuredModel: "configured-repair", actualReturnedModel: "returned-invalid",
        finalErrorCode: "generation_failed", failureDiagnostic: null }),
      expect.objectContaining({ jobId: "incomplete", finalStatus: "discarded", initialOutcome: "unknown", finalErrorCode: "generation_failed",
        configuredModel: "unknown", actualReturnedModel: "unknown" })
    ]));
    expect(report.cohorts).toEqual(expect.arrayContaining([
      expect.objectContaining({ configuredModel: "frozen-default-model", promptProtocol: "story-v14-continuity-context", executionProtocolHash: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: expect.objectContaining({ jobs: 1, initialValid: 1 }) }),
      expect.objectContaining({ configuredModel: "configured", promptProtocol: "story-v15-canonical-fact-format", executionProtocolHash: expect.stringMatching(/^[a-f0-9]{64}$/), metrics: expect.objectContaining({ jobs: 1, initialValid: 1 }) }),
      expect.objectContaining({ configuredModel: "configured-repair", promptProtocol: "prompt-library-v1-dc1b588a0a37f571", playMode: "story_only", contextBucket: "32k-127k",
        metrics: expect.objectContaining({ jobs: 1, initialInvalid: 1, validRepairResponses: 1 }) })
    ]));
    const cohorts = report.cohorts as unknown as Array<{ promptProtocol: string; executionProtocolHash: string }>;
    const v14 = cohorts.find((cohort) => cohort.promptProtocol === "story-v14-continuity-context")!;
    const v15 = cohorts.find((cohort) => cohort.promptProtocol === "story-v15-canonical-fact-format")!;
    expect(v14.executionProtocolHash).not.toBe(v15.executionProtocolHash);
    expect(cohorts).toEqual(expect.arrayContaining([expect.objectContaining({ promptProtocol: "unknown", executionProtocolHash: "unknown" })]));
    expect(JSON.stringify(report)).not.toContain("MODEL_SECRET");
    expect(JSON.stringify(report)).not.toContain(enrolledV14);
    expect(JSON.stringify(report)).not.toContain(enrolledV15);
    expect(JSON.stringify(report)).not.toContain(oldStoryOnlyProtocol);
  });

  it("labels only validated old and marked non-enrolled execution identities", async () => {
    const baseIdentity = "prompt-library-v1-5d636b749d679ddc";
    const policy = storyOnlyPolicy();
    const oldStoryDirectionIdentity = generationExecutionProtocolIdentity(baseIdentity, policy);
    const markedIdentity = `story-prompt-v1|${storyPromptCompatibilityIdentity()}|${oldStoryDirectionIdentity}`;
    const mismatchedPolicyHash = `${baseIdentity}|${"b".repeat(64)}`;
    const malformedMarker = `story-prompt-v1|story-v16-fact-wire-distinction|story-output-v2|current-continuity-v3|${oldStoryDirectionIdentity}`;
    const validProof = { protocolIdentity: storyPromptCompatibilityIdentity(), templateHash: "a".repeat(64) };
    const jobs = [
      { id: "old", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: oldStoryDirectionIdentity,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy, storyPromptCompatibility: null },
      { id: "marked", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: markedIdentity,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy, storyPromptCompatibility: validProof },
      { id: "bad-policy-hash", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: mismatchedPolicyHash,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy, storyPromptCompatibility: null },
      { id: "bad-marker", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: malformedMarker,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy, storyPromptCompatibility: validProof },
      { id: "bad-proof", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: markedIdentity,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy,
        storyPromptCompatibility: { ...validProof, templateHash: "bad" } },
      { id: "bad-whitespace", status: "failed", createdAt: "2026-09-18T00:00:00.000Z", promptProtocol: ` ${oldStoryDirectionIdentity}`,
        requestedModel: "configured", errorCode: null, failureDiagnostic: null, contextOptions: null, generationPolicy: policy, storyPromptCompatibility: null }
    ];
    const query = vi.fn(async (text: string) => text.includes("FROM generation_jobs") ? { rows: jobs } : { rows: [] });

    const report = await readTurnValidationReport({ query } as any, { limit: 50, since: null, format: "json" });
    expect(report.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: "old", promptProtocol: baseIdentity, executionProtocolHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ jobId: "marked", promptProtocol: "story-v16-fact-wire-distinction", executionProtocolHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ jobId: "bad-policy-hash", promptProtocol: "unknown", executionProtocolHash: "unknown" }),
      expect.objectContaining({ jobId: "bad-marker", promptProtocol: "unknown", executionProtocolHash: "unknown" }),
      expect.objectContaining({ jobId: "bad-proof", promptProtocol: "unknown", executionProtocolHash: "unknown" }),
      expect.objectContaining({ jobId: "bad-whitespace", promptProtocol: "unknown", executionProtocolHash: "unknown" })
    ]));
    expect(generationPolicyIdentity(policy)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain(oldStoryDirectionIdentity);
    expect(JSON.stringify(report)).not.toContain(markedIdentity);
    expect(JSON.stringify(report)).not.toContain(mismatchedPolicyHash);
  });
});
