# Turn Generation Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe phase timing and recurring stall warnings across backend turn generation so delayed jobs reveal exactly which operation is pending.

**Architecture:** Add a focused diagnostics helper that wraps asynchronous phase work and emits structured start, completion, failure, and recurring stall events. Integrate that helper at meaningful awaited boundaries in `executeGenerationJob`, retaining all existing provider logs, transaction boundaries, retries, cancellation fencing, and API/UI behavior.

**Tech Stack:** TypeScript 7, Node.js timers, Pino logger, Vitest 4, PostgreSQL integration tests.

## Global Constraints

- Keep browser UI and API contracts unchanged.
- Production stall interval is exactly 30,000 milliseconds and warnings repeat every 30,000 milliseconds until the phase settles.
- Do not log player actions, generated narration, prompts, response bodies, scratchpads, private mechanics, retrieved-memory content, credentials, raw validation messages, or raw error messages.
- Preserve existing generation behavior, retries, transaction boundaries, cancellation fencing, lease handling, and error classification.
- Use two-space indentation, `camelCase` values, `PascalCase` types, and `UPPER_SNAKE_CASE` constants.
- Update tests associated with every changed source file.

## File Structure

- Create `services/api/src/generation-diagnostics.ts`: isolated phase timer, safe event construction, and timer cleanup.
- Create `tests/unit/generation-diagnostics.test.ts`: deterministic lifecycle, recurring stall, failure, and privacy tests for the helper.
- Modify `services/api/src/generation-service.ts`: wrap turn-generation boundaries with the diagnostics helper.
- Modify `tests/integration/generation.integration.test.ts`: verify end-to-end phase ordering, correlation, conditional recovery phases, and absence of private content.

---

### Task 1: Build the phase diagnostics helper

**Files:**
- Create: `services/api/src/generation-diagnostics.ts`
- Create: `tests/unit/generation-diagnostics.test.ts`

**Interfaces:**
- Consumes: a Pino-compatible logger with `info`, `warn`, and `error` methods accepting structured objects.
- Produces:

```ts
export const TURN_GENERATION_STALL_INTERVAL_MS = 30_000;

export type TurnGenerationPhase =
  | "provider_loading"
  | "input_preparation"
  | "context_retrieval"
  | "orchestration_loading"
  | "rpg_assessment"
  | "before_event_evaluation"
  | "prompt_preparation"
  | "streaming_illustration_setup"
  | "story_generation"
  | "story_validation"
  | "story_recovery"
  | "scene_coverage_validation"
  | "scene_coverage_rewrite"
  | "after_event_evaluation"
  | "event_extension"
  | "turn_commit";

export type TurnGenerationDiagnosticContext = {
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: string;
  jobAttempt: number;
  workerId: string;
};

export type TurnGenerationPhaseOptions = {
  logger: Pick<typeof logger, "info" | "warn" | "error">;
  context: TurnGenerationDiagnosticContext;
  phase: TurnGenerationPhase;
  generationStartedAt: number;
  stallIntervalMs?: number;
  now?: () => number;
};

export async function runTurnGenerationPhase<T>(
  options: TurnGenerationPhaseOptions,
  operation: () => Promise<T>
): Promise<T>;
```

- [ ] **Step 1: Write failing lifecycle and recurring-stall tests**

Create `tests/unit/generation-diagnostics.test.ts` with fake timers and a deterministic clock:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runTurnGenerationPhase,
  TURN_GENERATION_STALL_INTERVAL_MS
} from "../../services/api/src/generation-diagnostics.js";

const context = {
  generationJobId: "job-1",
  campaignId: "campaign-1",
  providerProfileId: "provider-1",
  expectedTurnNumber: 4,
  operationKind: "append",
  jobAttempt: 1,
  workerId: "worker-1"
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("turn generation phase diagnostics", () => {
  it("logs phase start and completion with correlated durations", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let now = 1_000;

    await expect(runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "context_retrieval",
      generationStartedAt: 500,
      now: () => now
    }, async () => {
      now = 1_250;
      return "context";
    })).resolves.toBe("context");

    expect(logger.info.mock.calls).toEqual([
      [{ event: "turn_generation_phase_started", ...context, phase: "context_retrieval", totalDurationMs: 500 }],
      [{ event: "turn_generation_phase_completed", ...context, phase: "context_retrieval", durationMs: 250, totalDurationMs: 750 }]
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("repeats safe stall warnings until the phase settles and then clears its timer", async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pending = deferred<string>();
    const startedAt = Date.now();
    const result = runTurnGenerationPhase({
      logger: logger as any,
      context,
      phase: "story_generation",
      generationStartedAt: startedAt,
      now: () => Date.now()
    }, () => pending.promise);

    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS * 2);
    expect(logger.warn.mock.calls).toEqual([
      [expect.objectContaining({ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 30_000, totalDurationMs: 30_000 })],
      [expect.objectContaining({ event: "turn_generation_phase_stalled", ...context, phase: "story_generation", durationMs: 60_000, totalDurationMs: 60_000 })]
    ]);

    pending.resolve("done");
    await expect(result).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(TURN_GENERATION_STALL_INTERVAL_MS);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the helper tests and verify they fail**

Run:

```bash
pnpm exec vitest run tests/unit/generation-diagnostics.test.ts
```

Expected: FAIL because `services/api/src/generation-diagnostics.ts` does not exist.

- [ ] **Step 3: Implement the minimal phase helper**

Create `services/api/src/generation-diagnostics.ts`:

```ts
import { logger as applicationLogger } from "../../../packages/logger/src/index.js";

export const TURN_GENERATION_STALL_INTERVAL_MS = 30_000;

export type TurnGenerationPhase =
  | "provider_loading"
  | "input_preparation"
  | "context_retrieval"
  | "orchestration_loading"
  | "rpg_assessment"
  | "before_event_evaluation"
  | "prompt_preparation"
  | "streaming_illustration_setup"
  | "story_generation"
  | "story_validation"
  | "story_recovery"
  | "scene_coverage_validation"
  | "scene_coverage_rewrite"
  | "after_event_evaluation"
  | "event_extension"
  | "turn_commit";

export type TurnGenerationDiagnosticContext = {
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: string;
  jobAttempt: number;
  workerId: string;
};

type DiagnosticLogger = Pick<typeof applicationLogger, "info" | "warn" | "error">;

export type TurnGenerationPhaseOptions = {
  logger: DiagnosticLogger;
  context: TurnGenerationDiagnosticContext;
  phase: TurnGenerationPhase;
  generationStartedAt: number;
  stallIntervalMs?: number;
  now?: () => number;
};

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String((error as { code?: unknown }).code || "");
  return /^[a-z][a-z0-9_]{0,63}$/i.test(code) ? code : "unclassified_error";
}

export async function runTurnGenerationPhase<T>(
  options: TurnGenerationPhaseOptions,
  operation: () => Promise<T>
): Promise<T> {
  const now = options.now ?? Date.now;
  const intervalMs = options.stallIntervalMs ?? TURN_GENERATION_STALL_INTERVAL_MS;
  const phaseStartedAt = now();
  const base = { ...options.context, phase: options.phase };
  options.logger.info({
    event: "turn_generation_phase_started",
    ...base,
    totalDurationMs: phaseStartedAt - options.generationStartedAt
  });
  const stallTimer = setInterval(() => {
    const current = now();
    options.logger.warn({
      event: "turn_generation_phase_stalled",
      ...base,
      durationMs: current - phaseStartedAt,
      totalDurationMs: current - options.generationStartedAt
    });
  }, intervalMs);
  stallTimer.unref?.();
  try {
    const result = await operation();
    const completedAt = now();
    options.logger.info({
      event: "turn_generation_phase_completed",
      ...base,
      durationMs: completedAt - phaseStartedAt,
      totalDurationMs: completedAt - options.generationStartedAt
    });
    return result;
  } catch (error) {
    const failedAt = now();
    const errorCode = safeErrorCode(error);
    options.logger.error({
      event: "turn_generation_phase_failed",
      ...base,
      errorName: error instanceof Error ? error.name : "Error",
      ...(errorCode ? { errorCode } : {}),
      durationMs: failedAt - phaseStartedAt,
      totalDurationMs: failedAt - options.generationStartedAt
    });
    throw error;
  } finally {
    clearInterval(stallTimer);
  }
}
```

- [ ] **Step 4: Add failure, cleanup, and privacy tests**

Append these tests inside the same `describe` block:

```ts
it("logs a sanitized failure and rethrows the original error", async () => {
  vi.useFakeTimers();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const privateMessage = "PRIVATE_PROVIDER_RESPONSE";
  const failure = Object.assign(new Error(privateMessage), {
    code: "https://secret.example/token"
  });

  await expect(runTurnGenerationPhase({
    logger: logger as any,
    context,
    phase: "turn_commit",
    generationStartedAt: Date.now(),
    now: () => Date.now()
  }, async () => { throw failure; })).rejects.toBe(failure);

  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
    event: "turn_generation_phase_failed",
    ...context,
    phase: "turn_commit",
    errorName: "Error",
    errorCode: "unclassified_error"
  }));
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateMessage);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret.example");
  expect(vi.getTimerCount()).toBe(0);
});

it("uses a controlled error code without serializing arbitrary error fields", async () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const failure = Object.assign(new Error("PRIVATE_PARSE_DETAILS"), {
    code: "generation_cancelled",
    prompt: "PRIVATE_PROMPT"
  });

  await expect(runTurnGenerationPhase({
    logger: logger as any,
    context,
    phase: "story_validation",
    generationStartedAt: 100,
    now: () => 200
  }, async () => { throw failure; })).rejects.toBe(failure);

  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
    errorCode: "generation_cancelled"
  }));
  const serialized = JSON.stringify(logger.error.mock.calls);
  expect(serialized).not.toContain("PRIVATE_PARSE_DETAILS");
  expect(serialized).not.toContain("PRIVATE_PROMPT");
});
```

- [ ] **Step 5: Run focused unit tests and type checking**

Run:

```bash
pnpm exec vitest run tests/unit/generation-diagnostics.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the helper**

```bash
git add services/api/src/generation-diagnostics.ts tests/unit/generation-diagnostics.test.ts
git commit -m "feat: add turn generation phase diagnostics"
```

---

### Task 2: Instrument the complete generation workflow

**Files:**
- Modify: `services/api/src/generation-service.ts:1623-2175`
- Modify: `tests/integration/generation.integration.test.ts:1308-1406`

**Interfaces:**
- Consumes: `runTurnGenerationPhase`, `TurnGenerationPhase`, and `TurnGenerationDiagnosticContext` from Task 1.
- Produces: phase lifecycle events surrounding all meaningful `executeGenerationJob` waits; no API or domain interface changes.

- [ ] **Step 1: Update the lifecycle integration test to require phase events**

In `logs correlated generation lifecycle and recovery metadata without private story content`, stop asserting one exact list containing only legacy events. Split the captured events into `phaseEvents` and `legacyEvents`, preserving the existing exact assertion for `legacyEvents`:

```ts
const phaseEvents = events.filter((event) => String(event.event).startsWith("turn_generation_phase_"));
const legacyEvents = events.filter((event) => !String(event.event).startsWith("turn_generation_phase_"));

expect(legacyEvents.map((event) => event.event)).toEqual([
  "turn_generation_claimed",
  "turn_generation_started",
  "turn_generation_provider_started",
  "turn_generation_stream_progress",
  "turn_generation_provider_completed",
  "turn_generation_validation_completed",
  "turn_generation_recovery_started",
  "turn_generation_provider_started",
  "turn_generation_provider_completed",
  "turn_generation_validation_completed",
  "turn_generation_completed"
]);

const completedPhases = phaseEvents
  .filter((event) => event.event === "turn_generation_phase_completed")
  .map((event) => event.phase);
expect(completedPhases).toEqual([
  "provider_loading",
  "input_preparation",
  "context_retrieval",
  "orchestration_loading",
  "rpg_assessment",
  "before_event_evaluation",
  "prompt_preparation",
  "streaming_illustration_setup",
  "story_generation",
  "story_validation",
  "story_recovery",
  "story_validation",
  "after_event_evaluation",
  "turn_commit"
]);
expect(phaseEvents.filter((event) => event.event === "turn_generation_phase_started")).toHaveLength(completedPhases.length);
expect(phaseEvents.filter((event) => event.event === "turn_generation_phase_failed")).toHaveLength(0);
expect(phaseEvents.filter((event) => event.event === "turn_generation_phase_stalled")).toHaveLength(0);
for (const event of phaseEvents) {
  expect(event).toMatchObject({
    generationJobId: job.id,
    campaignId: imported.campaignId,
    providerProfileId: providerId,
    expectedTurnNumber: 3,
    operationKind: "append",
    jobAttempt: 1,
    workerId: "story-worker-lifecycle-logs",
    phase: expect.any(String),
    totalDurationMs: expect.any(Number)
  });
}
for (const event of phaseEvents.filter((event) => event.event !== "turn_generation_phase_started")) {
  expect(event.durationMs).toEqual(expect.any(Number));
}
```

Retain the existing serialized-log assertions and add:

```ts
expect(serializedLogs).not.toContain("Open Location Gamma.");
```

Do not add any story or prompt values to expected structured events.

- [ ] **Step 2: Run the integration test and verify it fails**

Run with the repository test database configured:

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "logs correlated generation lifecycle"
```

Expected: FAIL because no `turn_generation_phase_*` events are emitted. If `TEST_DATABASE_URL` is absent, start the documented integration database first; do not treat a skipped test as evidence.

- [ ] **Step 3: Import the helper and construct one safe phase runner**

Add this import near the existing service imports:

```ts
import {
  runTurnGenerationPhase,
  type TurnGenerationDiagnosticContext,
  type TurnGenerationPhase
} from "./generation-diagnostics.js";
```

Immediately after `generationStartedAt` in `executeGenerationJob`, construct context and a local typed wrapper:

```ts
const diagnosticContext: TurnGenerationDiagnosticContext = {
  ...generationLogContext(job, workerId),
  workerId
};
const phase = <T>(phaseName: TurnGenerationPhase, operation: () => Promise<T>) =>
  runTurnGenerationPhase({
    logger,
    context: diagnosticContext,
    phase: phaseName,
    generationStartedAt
  }, operation);
```

If TypeScript reports `workerId` twice because `generationLogContext` already conditionally includes it, use the explicit object below instead of a cast:

```ts
const diagnosticContext: TurnGenerationDiagnosticContext = {
  generationJobId: job.id,
  campaignId: job.campaign_id,
  providerProfileId: job.provider_profile_id,
  expectedTurnNumber: job.expected_turn_number,
  operationKind: job.operation_kind,
  jobAttempt: job.attempts,
  workerId
};
```

- [ ] **Step 4: Wrap provider loading, input preparation, context, and orchestration**

Replace the opening operations with these boundaries:

```ts
const provider = await phase("provider_loading", () =>
  loadTextProvider(pool, job.owner_user_id, job.provider_profile_id, credentialSecret, job.requested_model));

const preparedInput = await phase("input_preparation", async () => {
  const safeAction = safeTurnInput(job.action);
  const storyLength = snapshottedStoryLength(job.context_options);
  const requestedContextWindow = Number(job.context_options.modelContextWindowTokens || provider.contextWindowTokens);
  const effectiveContextWindow = Math.min(provider.contextWindowTokens, requestedContextWindow);
  const inputTokenLimit = effectiveContextWindow - provider.maxOutputTokens;
  const emptyPromptContext = { worldCanon: {}, campaignCanon: {}, chronicle: [], currentScene: null };
  const storySystemPrompt = promptFromSnapshot(job.prompt_snapshot, "story_system");
  const fixedPromptEnvelope = budgetTokenEstimate(storySystemPrompt)
    + budgetTokenEstimate(buildStoryUserPrompt(emptyPromptContext, safeAction, false, [], storyLength, job.resolved_input_mode))
    + 1024;
  if (inputTokenLimit - fixedPromptEnvelope < 512) {
    throw Object.assign(new Error(`The provider context window (${effectiveContextWindow}) cannot fit the configured output reserve (${provider.maxOutputTokens}) and story prompt envelope.`), { code: "context_budget_invalid" });
  }
  const safeContextBudget = Math.max(512, Math.min(
    Number(job.context_options.budgetTokens || 32000),
    inputTokenLimit - fixedPromptEnvelope
  ));
  return { safeAction, storyLength, effectiveContextWindow, inputTokenLimit, storySystemPrompt, safeContextBudget };
});
const { safeAction, storyLength, effectiveContextWindow, inputTokenLimit, storySystemPrompt, safeContextBudget } = preparedInput;

const context = await phase("context_retrieval", () => buildContextPreview(
  pool,
  job.campaign_id,
  { ...job.context_options, budgetTokens: safeContextBudget, query: safeAction },
  credentialSecret,
  { generationJobId: job.id, operation: "retrieval_embedding" },
  job.operation_kind === "replace_latest"
    ? {
        throughTurnNumber: job.base_turn_number ?? 0,
        stateOverride: job.base_state_private,
        scratchpadSafeForPrompt: job.base_scratchpad_safe_for_prompt
      }
    : {}
));
const promptContext = context.scopes;
const inputs = await phase("orchestration_loading", () => loadOrchestrationInputs(pool, job));
```

The wrapper must return existing values without logging their contents.

- [ ] **Step 5: Wrap conditional RPG and before-event orchestration**

For `orchestration.roll`, retain the outer `if (orchestration.roll === undefined)` condition. Make its sole statement `await phase("rpg_assessment", async () => { ... });` and move the current nested action/stat check, provider assessment, local fallback, private roll, and both `persistOrchestration` assignments into that closure without changing their order. The closure returns `void`; it updates the existing mutable `orchestration` binding.

For `orchestration.beforeEvents`, retain the outer `if (orchestration.beforeEvents === undefined)` condition. Make its sole statement `await phase("before_event_evaluation", async () => { ... });` and move the current activated-event initialization, trigger filtering/evaluation, fallback capture, and final `persistOrchestration` assignment into that closure without changing their order.

The existing inner `try/catch` boundaries remain inside each phase so private assessment and trigger failures continue to fall back and persist their current private diagnostics. The phase reports completion when those designed fallbacks succeed; it reports failure only when an error escapes the existing fallback boundary.

- [ ] **Step 6: Wrap prompt preparation and streaming illustration setup**

Move the safe-guidance calculation, transition to `generating`, prompt trimming loop, fingerprint, context diagnostics, and memory defaults into:

```ts
const promptPreparation = await phase("prompt_preparation", async () => {
  // Execute the existing safeGuidance through storyMemoryDefaults logic.
  return { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults };
});
const { storyInput, contextFingerprint, contextDiagnostics, storyMemoryDefaults } = promptPreparation;
```

The `prompt_preparation` closure must include `assertActiveGenerationUpdate(generating, "entering generation")` immediately after the status-update query, before constructing `storyInput`.

Wrap only configuration/tracker initialization in the next phase:

```ts
const streamingIllustration = await phase("streaming_illustration_setup", async () => {
  const illustrationConfig = await loadStreamingIllustrationConfig(pool, job.owner_user_id, job.campaign_id)
    .catch(() => null);
  return {
    illustrationConfig,
    segmentTracker: illustrationConfig
      ? new StreamingSegmentTracker(illustrationConfig.segment_word_count)
      : null
  };
});
const { illustrationConfig, segmentTracker } = streamingIllustration;
```

Leave `onChunk` behavior unchanged. Streaming segment database work remains nested in `story_generation`, making stalls caused by awaited `onChunk` persistence visible as story-generation stalls.

- [ ] **Step 7: Wrap primary generation, validation persistence, and recovery**

Wrap the primary provider call:

```ts
let result = await phase("story_generation", () =>
  callCampaignTextProvider(pool, provider, job, "story_generation", primaryRequest));
```

Wrap parsing, validation metadata logging, and the initial `generation_attempts` upsert in `story_validation`. Return all values needed later:

```ts
let validation = await phase("story_validation", async () => {
  const parsed = parseStoryOutput(result.content, storyMemoryDefaults);
  const firstReason = result.outputLimited ? "output_limit" : (!parsed.ok ? parsed.code : null);
  const initialValidationErrors = parsed.ok ? [] : parsed.errors;
  const initialAttemptNumber = job.attempts * 2 - 1;
  logger.info({
    event: "turn_generation_validation_completed",
    ...generationLogContext(job, workerId),
    storyOperation: "story_generation",
    valid: parsed.ok && !result.outputLimited,
    outputLimited: result.outputLimited,
    validationCode: firstReason,
    validationErrorCount: initialValidationErrors.length,
    attemptNumber: initialAttemptNumber
  });
  await pool.query(
    `INSERT INTO generation_attempts (owner_user_id, generation_job_id, attempt_number, recovery_kind, request_metadata,
       response_metadata, provider_response_id, finish_reason, raw_output, validation_errors, completed_at)
     VALUES ($1,$2,$3,'initial',$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (generation_job_id, attempt_number) DO UPDATE SET response_metadata = EXCLUDED.response_metadata,
       provider_response_id = EXCLUDED.provider_response_id, finish_reason = EXCLUDED.finish_reason,
       raw_output = EXCLUDED.raw_output, validation_errors = EXCLUDED.validation_errors, completed_at = now()`,
    [job.owner_user_id, job.id, initialAttemptNumber,
      json({ model: provider.model, providerType: provider.providerType, contextFingerprint, contextDiagnostics }),
      json({ usage: result.usage, outputLimited: result.outputLimited, modelInstanceId: result.modelInstanceId }),
      result.responseId || null, result.finishReason || null, result.content || null, json(initialValidationErrors)]
  );
  return { parsed, firstReason, initialValidationErrors, initialAttemptNumber };
});
let { parsed, firstReason, initialValidationErrors, initialAttemptNumber } = validation;
```

Inside `if (firstReason)`, wrap only the recovery provider call in `story_recovery`, then wrap recovery parsing, validation logging, and attempt insertion in a second `story_validation` phase. Preserve the same `result`, `parsed`, and validation variables.

- [ ] **Step 8: Wrap scene coverage phases without changing fallback behavior**

For scene mode, wrap each provider-backed coverage attempt in `scene_coverage_validation`. Keep its existing `try/catch` outside the helper so provider failure still degrades to `coverage = null`:

```ts
try {
  const coverageResponse = await phase("scene_coverage_validation", () =>
    callCampaignTextProvider(pool, provider, job, "scene_coverage_validation", {
      systemPrompt: promptFromSnapshot(job.prompt_snapshot, "scene_coverage"),
      input: buildSceneCoveragePrompt(safeAction, parsed.story.narration)
    }));
  coverageOutputLimited = coverageResponse.outputLimited;
  coverage = coverageResponse.outputLimited ? null : parseSceneCoverageOutput(coverageResponse.content);
} catch {
  coverage = null;
}
```

Replace the rewrite assignment with:

```ts
result = await phase("scene_coverage_rewrite", () =>
  callCampaignTextProvider(pool, provider, job, "scene_coverage_rewrite", {
    ...baseRequest,
    recoveryInput: renderPromptTemplate(
      promptFromSnapshot(job.prompt_snapshot, "scene_coverage_rewrite"),
      { validation: stableStringify({
        missing_required_beats: coverage?.missing_required_beats || ["Coverage could not be verified."],
        contradictions: coverage?.contradictions || []
      }) }
    ),
    rejectedResponse
  }));
```

Use the same `phase("scene_coverage_validation", () => callCampaignTextProvider(...))` shape shown above for the post-rewrite coverage request. Leave parsing immediately after each provider phase. Leave the existing `turn_generation_scene_coverage_completed` count-only events and recoverable-state updates after parsing, outside the provider phase, so they retain their current control flow and privacy properties.

- [ ] **Step 9: Wrap post-generation events, optional extension, and commit**

After entering `validating`, wrap the complete conditional after-event block in `after_event_evaluation`, retaining its internal provider fallback and persistence behavior.

Wrap the complete conditional immediate-event extension block in `event_extension`, retaining its internal catch and `extensionError` persistence.

Wrap only the authoritative transaction in `turn_commit`:

```ts
const turnId = await phase("turn_commit", () =>
  withTransaction(pool, (client) => commitStory(
    client,
    job,
    committedStory,
    provider,
    result,
    contextFingerprint,
    contextDiagnostics,
    inputs,
    orchestration,
    safeAction,
    workerId
  )));
```

Keep `turn_generation_completed` after this phase so its duration remains the terminal whole-job duration.

- [ ] **Step 10: Run the focused integration and unit tests**

Run:

```bash
pnpm exec vitest run tests/unit/generation-diagnostics.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "logs correlated generation lifecycle"
```

Expected: PASS. Confirm the integration test actually runs rather than skips.

- [ ] **Step 11: Run all generation integration tests and type checking**

Run:

```bash
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts
pnpm exec tsc -p tsconfig.json --noEmit
```

Expected: PASS with no cancellation, recovery, streaming, scene-coverage, or commit regressions.

- [ ] **Step 12: Review logged fields for privacy**

Run:

```bash
rg -n "turn_generation_phase_|runTurnGenerationPhase" services/api/src/generation-service.ts services/api/src/generation-diagnostics.ts tests/unit/generation-diagnostics.test.ts tests/integration/generation.integration.test.ts
```

Inspect every phase-event object. Expected: phase logs contain only event name, correlation fields, phase name, duration fields, controlled error name, and sanitized error code. No action, prompt, narration, response, scratchpad, mechanics, memory content, credential, or error-message fields appear.

- [ ] **Step 13: Commit workflow instrumentation**

```bash
git add services/api/src/generation-service.ts tests/integration/generation.integration.test.ts
git commit -m "feat: trace turn generation phases"
```

---

### Task 3: Full verification and operational review

**Files:**
- Verify: `services/api/src/generation-diagnostics.ts`
- Verify: `services/api/src/generation-service.ts`
- Verify: `tests/unit/generation-diagnostics.test.ts`
- Verify: `tests/integration/generation.integration.test.ts`

**Interfaces:**
- Consumes: completed implementation from Tasks 1 and 2.
- Produces: verified diagnostics ready for review; no additional production interface.

- [ ] **Step 1: Run repository checks and all unit tests**

```bash
pnpm check
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 2: Run the complete integration suite**

```bash
pnpm test:integration
```

Expected: PASS with `TEST_DATABASE_URL` configured and no skipped database suites caused by missing infrastructure.

- [ ] **Step 3: Build production output**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Check formatting and inspect the complete implementation diff**

```bash
git diff --check HEAD~2..HEAD
repowise distill git diff HEAD~2..HEAD -- services/api/src/generation-diagnostics.ts services/api/src/generation-service.ts tests/unit/generation-diagnostics.test.ts tests/integration/generation.integration.test.ts
```

Expected: no whitespace errors, unrelated changes, unsafe payload logging, transaction-boundary changes, API/UI changes, or cancellation-fencing changes.

- [ ] **Step 5: Run targeted health and change-risk checks**

Use:

```text
repowise_get_health(
  targets=[
    "services/api/src/generation-diagnostics.ts",
    "services/api/src/generation-service.ts",
    "tests/unit/generation-diagnostics.test.ts",
    "tests/integration/generation.integration.test.ts"
  ],
  include=["biomarkers", "signals"]
)

repowise_get_change_risk(revspec="HEAD~2..HEAD", extensions=[".ts"])
```

Expected: review any new critical finding, missing-test bucket, or high review-priority warning before completion. Do not claim success if the risk response identifies a concrete uncovered changed-line test requirement.

- [ ] **Step 6: Record final evidence**

In the completion response, report:

- The likely delay boundaries found during investigation: provider waits up to the configured timeout, multiple hidden Step-4 provider/validation operations, and awaited streaming persistence/illustration work.
- The exact new event names and 30-second recurring stall behavior.
- The files changed.
- The commands run and whether each passed.
- Any skipped test and the infrastructure reason.
- Any remaining limitation: diagnostics identify the delayed phase on the next reproduction but do not claim a root cause without captured runtime logs.
