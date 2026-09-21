import { generationRecoverySchema } from "../../packages/contracts/src/client-api.js";
import { describe, expect, it } from "vitest";
import { projectSafeGenerationContextDiagnostic, projectSafeGenerationDiagnostic, safeGenerationDiagnosticSchema } from "../../packages/contracts/src/story-prompt.js";
import { projectGenerationFailureDiagnostic } from "../../packages/contracts/src/generation-review.js";
import { generationDiagnosticPresentation, generationResponseFormatPresentation, generationReviewPresentation } from "../../packages/client-core/src/generation/projection.js";

describe("safe public generation diagnostics", () => {
  it("projects fixed timeout and empty-output failure messages without private error details", () => {
    const privateMessage = "https://private.example/token?key=SECRET PRIVATE_NARRATION";
    expect(projectGenerationFailureDiagnostic({
      version: 1, category: "provider_timeout", code: "provider_request_timeout", phase: "story_generation", attemptNumber: 1,
      occurredAt: "2026-09-18T00:00:00.000Z", message: privateMessage
    })).toEqual({ code: "provider_request_timeout", message: "The provider request timed out." });
    expect(projectGenerationFailureDiagnostic({
      version: 1, category: "output_incomplete", code: "empty_output", phase: "story_validation", attemptNumber: 2,
      occurredAt: "2026-09-18T00:00:00.000Z", response: privateMessage
    })).toEqual({ code: "empty_output", message: "The provider returned no usable output." });
    expect(projectGenerationFailureDiagnostic({ code: "private_provider_token", message: privateMessage })).toBeNull();
  });
  it("uses server review eligibility ahead of an older discard-and-reenqueue diagnostic", () => {
    const presentation = generationReviewPresentation({
      version: 1, reviewId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, state: "pending",
      stage: "continuity", candidateScope: "final", reasons: ["narrative_conflict"], canKeep: true, canRetry: true
    }, {
      code: "context_budget_exceeded", operation: "story_generation", action: "discard_and_reenqueue"
    });

    expect(presentation).toMatchObject({ state: "review", canKeep: true, canRetry: true });
  });

  it("keeps an unknown review version non-authoritative", () => {
    expect(generationReviewPresentation({ version: 2, reviewId: "future", revision: 9, canKeep: true }))
      .toEqual(expect.objectContaining({ state: "unsupported", canKeep: false, canRetry: false }));
  });

  it("keeps bounded omission/review details and rejects private content", () => {
    const privateCanary = "PRIVATE_PROMPT_PROVIDER_AND_SCRATCHPAD_CANARY";
    const source = {
      code: "context_evidence_omitted", operation: "story_generation", action: "adjust_context",
      protocolIdentity: "story-v14-continuity-context|story-output-v2|current-continuity-v3",
      counts: { recentTurnsTarget: 3, recentTurnsIncluded: 1, optionalEvidenceOmitted: 2 },
      reasonCodes: ["recent_gap", "context_limit"], review: { status: "uncertain", automaticRepair: "not_consumed" },
      privatePrompt: privateCanary
    };
    expect(safeGenerationDiagnosticSchema.safeParse(source).success).toBe(false);
    const { privatePrompt: _privatePrompt, ...safeInput } = source;
    const presentation = generationDiagnosticPresentation(projectSafeGenerationDiagnostic(safeInput));
    expect(presentation.details).toEqual(expect.arrayContaining([
      "Recent turns: 1 of 3 included.", "Optional evidence: 2 omitted.",
      "Continuity review is uncertain; it was not a full-history pass."
    ]));
    expect(JSON.stringify(presentation)).not.toContain(privateCanary);
  });

  it("reduces private planning layers to fixed counts and reason codes", () => {
    const privateId = "PRIVATE_EXCERPT_AND_SOURCE_ID";
    const safe = projectSafeGenerationContextDiagnostic({
      layers: { recent: { target: 3, included: 1, firstGapReason: "recent_gap" }, duplicateSourceCount: 2, components: { rules: 120 }, excerptsComplete: 2, excerptsPartial: 1, sourceValidationFailures: 1, omitted: [{ id: privateId, reason: "context_limit" }] },
      worldReferenceOmissions: { unrecognizedRecordCount: 1, missingEndpointCount: 2, entityCapCount: 3 }
    });
    expect(safe).toMatchObject({ reasonCodes: expect.arrayContaining(["recent_gap", "context_limit", "unsupported_world_shape", "duplicate_source", "source_validation_failed"]), counts: { authorityComponents: 1, optionalEvidenceOmitted: 1, excerptsComplete: 2, excerptsPartial: 1, sourceValidationFailures: 1, worldReferencesOmitted: 6 } });
    expect(JSON.stringify(safe)).not.toContain(privateId);
  });

  it("renders only allowlisted protected component estimates", () => {
    const source = { code: "context_budget_exceeded", operation: "story_generation", action: "adjust_context", protectedComponents: { rules: 120, world_canon: 240, character_profile: 360 }, privateRule: "PRIVATE" };
    expect(safeGenerationDiagnosticSchema.safeParse(source).success).toBe(false);
    const { privateRule: _privateRule, ...safeInput } = source;
    expect(generationDiagnosticPresentation(safeInput).details).toContain("Protected context estimates: rules 120, world canon 240, character profile 360.");
  });
  it("keeps old-client recovery usable while dropping an unknown private diagnostic", () => {
    const parsed = generationRecoverySchema.parse({ id: "55555555-5555-4555-8555-555555555555", status: "recoverable", expectedTurnNumber: 2, attempts: 1, operationKind: "append", replacementTurnId: null, resultTurnId: null, errorCode: "generation_failed", errorMessage: "Generation could not be completed.", diagnostic: { code: "future_code", private: "PRIVATE_CANARY" } });
    expect(parsed.diagnostic).toBeNull(); expect(JSON.stringify(parsed)).not.toContain("PRIVATE_CANARY");
  });

  it("presents a saved required preflight failure without inventing review authority", () => {
    const presentation = generationResponseFormatPresentation({
      version: 1,
      savedPolicy: "required",
      effectiveMode: "unavailable",
      schemaVersion: null,
      schemaHash: null,
      operation: "story",
      streaming: true,
      requestedModel: "saved-story-model",
      returnedModel: null,
      returnedRoute: null,
      preflight: "identity_mismatch",
      preflightDiagnostic: null,
      diagnosticCode: null
    });

    expect(presentation).toEqual({
      heading: "Saved response format: Required",
      details: [
        "Effective mode: Unavailable for the saved story operation.",
        "The saved provider identity no longer matches this job. Review the provider settings before starting a new generation.",
        "Historical jobs keep their saved response-format selection."
      ],
      retryable: false
    });
  });

  it("presents the finite unsupported-adapter marker without changing review authority", () => {
    expect(generationResponseFormatPresentation({
      version: 1,
      savedPolicy: "auto",
      effectiveMode: "unavailable",
      schemaVersion: null,
      schemaHash: null,
      operation: null,
      streaming: null,
      requestedModel: null,
      returnedModel: null,
      returnedRoute: null,
      preflight: "unavailable",
      preflightDiagnostic: "unsupported_adapter",
      diagnosticCode: null
    })).toEqual(expect.objectContaining({
      heading: "Saved response format: Auto",
      retryable: false,
      details: expect.arrayContaining(["The saved provider adapter does not support response formats. Review the provider settings before starting a new generation."])
    }));
  });

  it("distinguishes verified Models from trusted Presets and reports requested and served identities", () => {
    expect(generationResponseFormatPresentation({
      version: 2, savedPolicy: "required", effectiveMode: "json_schema", schemaVersion: "story-native-v1",
      schemaHash: "a".repeat(64), operation: "story", streaming: true, preflight: "selected",
      preflightDiagnostic: null, diagnosticCode: null,
      requestedSelection: { kind: "openrouter_preset", slug: "night-shift" }, assurance: "trusted_preset",
      actualServedIdentity: { status: "known", model: "served-model", providerRoute: null }
    })?.details).toEqual(expect.arrayContaining([
      "Effective mode: Trusted preset schema for the saved story operation.",
      "Requested selection: Preset night-shift.",
      "Actual served model: served-model.",
      "Actual provider route: Unknown."
    ]));

    expect(generationResponseFormatPresentation({
      version: 2, savedPolicy: "auto", effectiveMode: "json_schema", schemaVersion: "story-native-v1",
      schemaHash: "b".repeat(64), operation: "story", streaming: true, preflight: "selected",
      preflightDiagnostic: null, diagnosticCode: null,
      requestedSelection: { kind: "model", modelId: "requested-model" }, assurance: "verified_model",
      actualServedIdentity: { status: "unknown", model: null, providerRoute: null }
    })?.details).toEqual(expect.arrayContaining([
      "Effective mode: Verified Model schema for the saved story operation.",
      "Requested selection: Model requested-model.",
      "Actual served model: Unknown.",
      "Actual provider route: Unknown."
    ]));
  });
});
