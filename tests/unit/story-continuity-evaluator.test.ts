import { createHash } from "node:crypto";
import { createStoryEvidence, generationEvidenceManifestHash } from "../../packages/application/src/memory/generation-context.js";
import { describe, expect, it } from "vitest";
import {
  createPrivateArtifactManifest,
  buildDeterministicFixtureEvaluation,
  deriveStoryContinuityRunFromExecutorCapture,
  executeCappedLiveEvaluation,
  evaluateStoryContinuity,
  validateLiveConfiguration,
  wilsonInterval,
  parseContinuityCorpus
} from "../../scripts/lib/story-continuity-evaluator.js";

const sourceId = "source-relay-key";

describe("story continuity evaluator", () => {
  it("keeps the versioned scenario matrix separate from deterministic candidate output", () => {
    const fixture = buildDeterministicFixtureEvaluation();
    expect(fixture.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(new Set(fixture.scenarios.map((scenario) => scenario.trajectory))).toEqual(new Set(["teacher_forced", "rollout"]));
    for (const [index, scenario] of fixture.scenarios.entries()) {
      const candidate = fixture.candidateOutputs[index]!;
      expect(scenario.sourceEvidence.every((evidence) => !candidate.includes(evidence.text))).toBe(true);
    }
  });

  it("scores source, candidate, sent, and accepted use independently by source identity", () => {
    const report = evaluateStoryContinuity({
      corpusVersion: "story-continuity-evaluator-corpus-v1",
      scenarios: [{
        id: "identity-not-keyword",
        trajectory: "teacher_forced",
        sourceEvidence: [{ id: sourceId, text: "The original relay key is beneath the north stair.", required: true }]
      }],
      runs: [{
        scenarioId: "identity-not-keyword",
        trajectory: "teacher_forced",
        outputMode: "baseline",
        provider: { id: "deterministic-fake", model: "fixture-v1", settingsHash: "a".repeat(64) },
        sourceAvailableIds: [sourceId],
        candidateRetrievedIds: [sourceId],
        sentEvidenceIds: [sourceId],
        accepted: {
          outcome: "pass",
          ignoredEvidenceIds: [sourceId],
          narrationContradictionEvidenceIds: [],
          unsupportedStateEvidenceIds: [],
          omissionWarningEvidenceIds: [],
          excludedPrivateEvidenceIds: [],
          replacementFields: [{ path: "/continuity_summary", evidenceId: sourceId, status: "pass" }],
          replay: { status: "pass", replacementFields: [{ path: "/continuity_summary", evidenceId: sourceId, status: "pass" }] }
        }
      }]
    });

    expect(report.strata[0]?.layers.sourceAvailable.pass).toBe(1);
    expect(report.strata[0]?.layers.candidateRetrieved.pass).toBe(1);
    expect(report.strata[0]?.layers.evidenceSent.pass).toBe(1);
    expect(report.strata[0]?.layers.acceptedOutputConsistent.fail).toBe(1);
    expect(report.errors.evidencePresentButIgnored).toEqual([expect.objectContaining({ evidenceId: sourceId })]);
    expect(report.strata).toHaveLength(1);
    expect(report.strata[0]).toMatchObject({ trajectory: "teacher_forced", outputMode: "baseline" });
  });

  it("rejects fabricated review quotations and makes the accepted judgment uncertain", () => {
    const report = evaluateStoryContinuity({
      corpusVersion: "story-continuity-evaluator-corpus-v1",
      scenarios: [{
        id: "fabricated-quote",
        trajectory: "rollout",
        sourceEvidence: [{ id: sourceId, text: "Ilyra guards the silver seal.", required: true }]
      }],
      runs: [{
        scenarioId: "fabricated-quote",
        trajectory: "rollout",
        outputMode: "observe",
        provider: { id: "deterministic-fake", model: "fixture-v1", settingsHash: "b".repeat(64) },
        sourceAvailableIds: [sourceId],
        candidateRetrievedIds: [sourceId],
        sentEvidenceIds: [sourceId],
        accepted: {
          outcome: "pass",
          ignoredEvidenceIds: [],
          narrationContradictionEvidenceIds: [],
          unsupportedStateEvidenceIds: [],
          omissionWarningEvidenceIds: [],
          excludedPrivateEvidenceIds: [],
          replacementFields: [],
          replay: { status: "pass", replacementFields: [] },
          reviewFindings: [{
            kind: "contradiction",
            evidenceId: sourceId,
            quote: "A fabricated quotation.",
            target: "source"
          }]
        }
      }]
    });

    expect(report.strata[0]?.layers.acceptedOutputConsistent.uncertain).toBe(1);
    expect(report.errors.invalidReviewEvidence).toEqual([expect.objectContaining({ reason: "quote_not_found" })]);
    expect(report.strata[0]!.contradictions.proposed).toBe(0);
  });

  it("keeps replacement-state and replay failures separate from narration contradictions and excluded private fields", () => {
    const report = evaluateStoryContinuity({
      corpusVersion: "story-continuity-evaluator-corpus-v1",
      scenarios: [{
        id: "replacement-replay",
        trajectory: "rollout",
        sourceEvidence: [{ id: sourceId, text: "The lantern is blue.", required: true }]
      }],
      runs: [{
        scenarioId: "replacement-replay",
        trajectory: "rollout",
        outputMode: "repaired",
        provider: { id: "deterministic-fake", model: "fixture-v1", settingsHash: "c".repeat(64) },
        sourceAvailableIds: [sourceId], candidateRetrievedIds: [sourceId], sentEvidenceIds: [sourceId],
        accepted: {
          outcome: "pass", ignoredEvidenceIds: [], narrationContradictionEvidenceIds: [sourceId],
          unsupportedStateEvidenceIds: [sourceId], omissionWarningEvidenceIds: [sourceId], excludedPrivateEvidenceIds: [sourceId],
          replacementFields: [{ path: "/open_threads", evidenceId: sourceId, status: "fail" }],
          replay: { status: "fail", replacementFields: [{ path: "/open_threads", evidenceId: sourceId, status: "fail" }] }
        }
      }]
    });

    expect(report.errors.narrationContradictions).toHaveLength(1);
    expect(report.errors.unsupportedProposedState).toHaveLength(1);
    expect(report.errors.omissionWarnings).toHaveLength(1);
    expect(report.errors.excludedPrivateFields).toHaveLength(1);
    expect(report.strata[0]!.replacementState.fail).toBe(1);
    expect(report.strata[0]!.replay.fail).toBe(1);
    expect(report.strata[0]?.layers.acceptedOutputConsistent.pass).toBe(0);
  });

  it.each([true, false])("scores accepted output independently of replay and upstream availability (%s)", (available) => {
    const report = evaluateStoryContinuity({
      corpusVersion: "story-continuity-evaluator-corpus-v1",
      scenarios: [{
        id: "accepted-independent-of-replay",
        trajectory: "rollout",
        sourceEvidence: [{ id: sourceId, text: "The harbor gate is open.", required: true }]
      }],
      runs: [{
        scenarioId: "accepted-independent-of-replay",
        trajectory: "rollout",
        outputMode: "repaired",
        provider: { id: "deterministic-fake", model: "fixture-v1", settingsHash: "d".repeat(64) },
        sourceAvailableIds: available ? [sourceId] : [], candidateRetrievedIds: available ? [sourceId] : [], sentEvidenceIds: available ? [sourceId] : [],
        accepted: {
          outcome: "pass", ignoredEvidenceIds: [], narrationContradictionEvidenceIds: [],
          unsupportedStateEvidenceIds: [], omissionWarningEvidenceIds: [], excludedPrivateEvidenceIds: [],
          replacementFields: [{ path: "/continuity_summary", evidenceId: sourceId, status: "pass" }],
          replay: { status: "fail", replacementFields: [{ path: "/currentContinuity/continuitySummary", evidenceId: sourceId, status: "fail" }] }
        }
      }]
    });

    expect(report.strata[0]!.layers.acceptedOutputConsistent).toMatchObject({ pass: 1, fail: 0 });
    expect(report.strata[0]!.replacementState).toMatchObject({ pass: 1, fail: 0 });
    expect(report.strata[0]!.replay).toMatchObject({ pass: 0, fail: 1 });
    expect(() => evaluateStoryContinuity({
      corpusVersion: "story-continuity-evaluator-corpus-v1",
      scenarios: [{ id: "unknown-replay-evidence", trajectory: "rollout", sourceEvidence: [{ id: sourceId, text: "The harbor gate is open.", required: true }] }],
      runs: [{
        scenarioId: "unknown-replay-evidence", trajectory: "rollout", outputMode: "repaired",
        provider: { id: "deterministic-fake", model: "fixture-v1", settingsHash: "e".repeat(64) },
        sourceAvailableIds: [sourceId], candidateRetrievedIds: [sourceId], sentEvidenceIds: [sourceId],
        accepted: {
          outcome: "pass", ignoredEvidenceIds: [], narrationContradictionEvidenceIds: [], unsupportedStateEvidenceIds: [], omissionWarningEvidenceIds: [], excludedPrivateEvidenceIds: [], replacementFields: [],
          replay: { status: "fail", replacementFields: [{ path: "/currentContinuity/continuitySummary", evidenceId: "unknown-evidence", status: "fail" }] }
        }
      }]
    })).toThrow(/replay replacement field/i);
  });

  it("keeps live execution blocked until every copy, provider, and ceiling is explicit", () => {
    expect(() => validateLiveConfiguration({ explicitLive: true, providerId: "provider" })).toThrow(/campaign copy.*maxCalls.*token.*cost/i);
    expect(validateLiveConfiguration({
      explicitLive: true, providerId: "provider", providerModel: "pinned-model", scenarioVersion: "v1",
      sourceCampaignId: "source-campaign", copiedCampaignId: "copy-campaign", maxCalls: 2,
      maxInputTokens: 1_000, maxOutputTokens: 500, maxCostUsd: 0.25
    })).toMatchObject({ providerId: "provider", copiedCampaignId: "copy-campaign", maxCalls: 2 });
  });

  it("reserves capped live usage before dispatching the next request", async () => {
    const configuration = validateLiveConfiguration({ explicitLive: true, providerId: "provider", providerModel: "pinned-model", scenarioVersion: "v1", sourceCampaignId: "source", copiedCampaignId: "copy", maxCalls: 2, maxInputTokens: 10, maxOutputTokens: 10, maxCostUsd: 1 });
    const dispatched: number[] = [];
    const result = await executeCappedLiveEvaluation(configuration, async (index) => { dispatched.push(index); return { inputTokens: 5, outputTokens: 5, costUsd: 0.5 }; }, () => ({ inputTokens: 6, outputTokens: 6, costUsd: 0.6 }));
    expect(result.calls).toBe(1); expect(dispatched).toEqual([0]);
  });

  it("creates a private 30-day manifest without credentials or provider endpoints", () => {
    const manifest = createPrivateArtifactManifest({
      runId: "continuity-run", sourceAuthorization: "operator approved copied campaign", copiedDestination: "copy-campaign",
      privateArtifactDirectory: "C:\\operator-private\\continuity", issuedAt: "2026-09-16T12:00:00.000Z",
      artifactPaths: ["C:\\operator-private\\continuity\\raw-output.json"], accessPolicy: "operator/current-owner review team"
    });
    expect(manifest.expiresAt).toBe("2026-10-16T12:00:00.000Z");
    expect(JSON.stringify(manifest)).not.toMatch(/api[_-]?key|https?:\/\//i);
    expect(() => createPrivateArtifactManifest({ ...manifest, artifactPaths: ["C:\\operator-private\\continuity-other\\raw-output.json"] })).toThrow(/stay under/i);
  });

  it("binds captured evidence to source identity and wire field, and scores independent replacement oracles", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const text = "The relay key is under the stair.";
    const authority = { currentScene: { narration: text } };
    const entry = createStoryEvidence({ source: { kind: "turn", id: "accepted-turn", revision: "1", turnNumber: 1 }, sourcePath: "/currentScene/narration", semanticRole: "accepted_narration", normalizationVersion: "fiction-safe-json-v1", form: "complete", spans: [], selectionGroup: "protected", rank: 0, canonicalFactId: null }, authority);
    const capturedRequestBody = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: authority }) }] });
    const base = { version: "generation-evidence-v1" as const, attemptId: "00000000-0000-4000-8000-000000000001", producingRequestHash: hash(capturedRequestBody), entries: [entry], requiredReviewEvidenceIds: [entry.id] };
    const record = { sourceId: "accepted-turn", sourcePath: entry.sourcePath, contentHash: hash(text), content: text };
    const capture = {
      scenarioId: "captured-teacher-history", trajectory: "teacher_forced" as const, outputMode: "baseline" as const,
      provider: { id: "fake-provider", model: "fake-model", settingsHash: "e".repeat(64) },
      sourceEvidence: [{ id: sourceId, text, required: true, ...record }], sourceRecords: [record], candidateRecords: [record],
      sourceEvidenceManifest: { ...base, manifestHash: generationEvidenceManifestHash(base) }, capturedRequestBody,
      acceptedTurn: { narration: "You retrieve it from beneath the stairs.", continuitySummary: "The key is carried." },
      fieldOracles: [{ path: "/continuitySummary", evidenceId: sourceId, expected: "The key is carried." }],
      replayState: { continuitySummary: "The key is carried." }, replayRequestBody: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: { currentScene: { narration: "You retrieve it from beneath the stairs." }, currentContinuity: { continuitySummary: "The key is carried." } } }) }] })
    };
    const run = deriveStoryContinuityRunFromExecutorCapture(capture);
    expect(run.accepted.replay.status).toBe("pass");
    const missingReplay = deriveStoryContinuityRunFromExecutorCapture({ ...capture, replayRequestBody: JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: { currentScene: { narration: "You retrieve it from beneath the stairs." }, currentContinuity: { continuitySummary: "Wrong previous state." } } }) }] }) });
    expect(missingReplay.accepted.replay.status).toBe("fail");
    expect(missingReplay.accepted.replay.requestFields).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/currentContinuity/continuitySummary", status: "fail" })]));

    expect(run.sourceAvailableIds).toEqual([sourceId]); expect(run.sentEvidenceIds).toEqual([sourceId]);
    expect(run.accepted.outcome).toBe("pass"); expect(run.accepted.replay.status).toBe("pass");
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, candidateRecords: [{ ...record, sourceId: "other-turn" }] }).candidateRetrievedIds).toEqual([]);
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, acceptedTurn: { ...capture.acceptedTurn, continuitySummary: "The key never existed." } }).accepted.outcome).toBe("fail");
    expect(() => deriveStoryContinuityRunFromExecutorCapture({ ...capture, capturedRequestBody: capturedRequestBody + " " })).toThrow(/request/i);
    const misplaced = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: { currentScene: { narration: "Absent." } }, irrelevant: text }) }] });
    const misplacedBase = { ...base, producingRequestHash: hash(misplaced) };
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, capturedRequestBody: misplaced, sourceEvidenceManifest: { ...misplacedBase, manifestHash: generationEvidenceManifestHash(misplacedBase) } }).sentEvidenceIds).toEqual([]);
  });

  it("rebinds excerpt parent hashes and exact spans instead of granting a whole-source pass", () => {
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const parent = "The keeper waits. The key is silver. The tide rises.";
    const text = "The key is silver.";
    const start = parent.indexOf(text); const spans = [{ start, end: start + text.length }];
    const entry = createStoryEvidence({ source: { kind: "turn", id: "parent-turn", revision: "1", turnNumber: 1 }, sourcePath: "/text", semanticRole: "accepted_narration", normalizationVersion: "story-fiction-source-v1", form: "excerpt", spans, selectionGroup: "retrieved", rank: 0, canonicalFactId: null }, { text: parent }, { contentHash: hash(parent) });
    const capturedRequestBody = JSON.stringify({ messages: [{ role: "user", content: JSON.stringify({ authoritative_context: { chronicle: [{ turnId: "parent-turn", sourceHash: hash(parent), content: text }] } }) }] });
    const base = { version: "generation-evidence-v1" as const, attemptId: "00000000-0000-4000-8000-000000000001", producingRequestHash: hash(capturedRequestBody), entries: [entry], requiredReviewEvidenceIds: [entry.id] };
    const record = { sourceId: "parent-turn", sourcePath: "/text", contentHash: hash(parent), content: parent };
    const capture = { scenarioId: "excerpt", trajectory: "teacher_forced" as const, outputMode: "baseline" as const,
      provider: { id: "fixture", model: "fixture", settingsHash: "a".repeat(64) },
      sourceEvidence: [{ id: sourceId, text, required: true, sourceId: record.sourceId, sourcePath: record.sourcePath, contentHash: record.contentHash, spans }],
      sourceRecords: [record], candidateRecords: [record], sourceEvidenceManifest: { ...base, manifestHash: generationEvidenceManifestHash(base) }, capturedRequestBody,
      acceptedTurn: { narration: text, continuitySummary: text }, fieldOracles: [{ path: "/continuitySummary", evidenceId: sourceId, expected: text }], replayState: { continuitySummary: text }, replayRequestBody: "" };
    expect(deriveStoryContinuityRunFromExecutorCapture(capture).sentEvidenceIds).toEqual([sourceId]);
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, sourceEvidence: [{ ...capture.sourceEvidence[0]!, text: parent, spans: [] }] }).sentEvidenceIds).toEqual([]);
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, sourceRecords: [{ ...record, sourceId: "duplicate-words-different-turn" }] }).sentEvidenceIds).toEqual([]);
    expect(deriveStoryContinuityRunFromExecutorCapture({ ...capture, sourceRecords: [{ ...record, content: parent + " Changed." }] }).sentEvidenceIds).toEqual([]);
  });

  it("keeps independent blinded labels and operational measures in their own strata", () => {
    const accepted = { outcome: "uncertain" as const, ignoredEvidenceIds: [], narrationContradictionEvidenceIds: [], unsupportedStateEvidenceIds: [], omissionWarningEvidenceIds: [], excludedPrivateEvidenceIds: [], replacementFields: [], replay: { status: "uncertain" as const, replacementFields: [] } };
    const base = { scenarioId: "labels", trajectory: "teacher_forced" as const, provider: { id: "fake", model: "fake", settingsHash: "a".repeat(64) }, sourceAvailableIds: [sourceId], candidateRetrievedIds: [sourceId], sentEvidenceIds: [sourceId], accepted };
    const registration = { seeds: ["repeat-1"], pairedMethod: "paired", frozenLabelVersion: "labels-1", blindedRubricVersion: "rubric-1" };
    const label = { blinded: true as const, assessorId: "independent-reviewer", labelVersion: "labels-1", rubricVersion: "rubric-1", contradictionTruePositive: 1, contradictionFalsePositive: 1, contradictionFalseNegative: 2, semanticFalseBlock: true, operationalFalseBlock: false, completed: false, writingQuality: 3, directionCoverage: 0.5 };
    const input = { corpusVersion: "test", preregistration: registration, scenarios: [{ id: "labels", trajectory: "teacher_forced" as const, sourceEvidence: [{ id: sourceId, text: "Source", required: true }] }], runs: [{ ...base, outputMode: "baseline" as const, providerCalls: 1 }, { ...base, outputMode: "repaired" as const, providerCalls: 4, repairCalls: 1, adjudication: label }] };
    const report = evaluateStoryContinuity(input);
    expect(report).not.toHaveProperty("adjudication"); expect(report).not.toHaveProperty("operational");
    expect(report.strata[0]!.adjudication).toMatchObject({ status: "skipped", unlabelled: 1 });
    expect(report.strata[1]!.adjudication).toMatchObject({ status: "measured", contradictionPrecision: { numerator: 1, denominator: 2 }, contradictionRecall: { numerator: 1, denominator: 3 }, completionRate: { numerator: 0, denominator: 1 } });
    expect(report.strata[1]!.contradictions).toMatchObject({ proposed: 2, validated: 1, precision: { numerator: 1, denominator: 2 }, recall: { numerator: 1, denominator: 3 } });
    expect(report.strata[1]!.operational).toMatchObject({ extraProviderCalls: 3, repairRate: { numerator: 1, denominator: 1 } });
    expect(() => evaluateStoryContinuity({ ...input, runs: [{ ...input.runs[1]!, adjudication: { ...label, labelVersion: "unregistered" } }] })).toThrow(/preregistered/);
  });

  it("rejects a misaligned candidate corpus rather than silently scoring the wrong scenario", async () => {
    const { default: corpus } = await import("../../scripts/fixtures/story-continuity-evaluator-corpus.v1.json", { with: { type: "json" } });
    expect(parseContinuityCorpus(corpus).candidates).toHaveLength(20);
    expect(() => parseContinuityCorpus({ ...corpus, candidates: corpus.candidates.slice(1) })).toThrow(/one-to-one/);
    expect(() => parseContinuityCorpus({ ...corpus, candidates: corpus.candidates.map((candidate) => ({ ...candidate, scenarioId: "duplicate" })) })).toThrow(/one-to-one/);
  });

  it("uses Wilson intervals whose denominator retains failed, skipped, and uncertain attempts", () => {
    expect(wilsonInterval(0, 4)).toMatchObject({ lower: 0, upper: expect.any(Number), denominator: 4 });
    expect(wilsonInterval(4, 4).upper).toBe(1);
    expect(() => wilsonInterval(3, 2)).toThrow(/numerator/i);
  });
});
