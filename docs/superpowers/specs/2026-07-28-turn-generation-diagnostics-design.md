# Turn Generation Diagnostics Design

## Purpose

Turn generation can remain on the player-visible “Writing scene” step for an extended period without identifying which internal operation is pending. Current evidence does not establish one deterministic defect. The visible step covers multiple provider, validation, orchestration, persistence, and optional illustration operations, and provider requests may remain pending until the configured request timeout, which defaults to five minutes.

Add structured backend diagnostics that identify where elapsed time is spent without exposing story content, prompts, credentials, private mechanics, scratchpads, or model reasoning.

## Scope

Instrument the backend turn-generation worker path from the start of `executeGenerationJob` through its terminal completion, recoverable result, failure, or cancellation. Keep the browser UI and API contracts unchanged.

Existing provider request logs remain authoritative for provider-specific request timing. The new instrumentation supplies the surrounding phase timeline and waiting signals.

## Diagnostic Model

Introduce one small phase-timing helper local to the generation service. It runs an asynchronous operation while emitting structured lifecycle events:

- `turn_generation_phase_started`
- `turn_generation_phase_completed`
- `turn_generation_phase_failed`
- `turn_generation_phase_stalled`

Every event includes the existing safe generation correlation context:

- `generationJobId`
- `campaignId`
- `providerProfileId`
- `expectedTurnNumber`
- `operationKind`
- `jobAttempt`
- `workerId`
- `phase`
- `totalDurationMs`

Completion and failure events also include `durationMs`. Failure events include only a controlled error name and sanitized error code. They must not include error messages because provider or parser messages can contain untrusted response content.

A phase emits a stall warning after 30 seconds and every 30 seconds thereafter until it settles. The helper clears its timer in all completion and failure paths and rethrows failures unchanged.

## Phases

Instrument meaningful awaited boundaries rather than every individual database statement:

1. `provider_loading`
2. `input_preparation`
3. `context_retrieval`
4. `orchestration_loading`
5. `rpg_assessment`
6. `before_event_evaluation`
7. `prompt_preparation`
8. `streaming_illustration_setup`
9. `story_generation`
10. `story_validation`
11. `story_recovery`
12. `scene_coverage_validation`
13. `scene_coverage_rewrite`
14. `after_event_evaluation`
15. `event_extension`
16. `turn_commit`

Conditional phases are logged only when executed. Existing provider-operation logs remain nested within the corresponding generation phase.

The `turn_commit` phase covers the complete transaction, including authoritative turn/state changes and the enqueueing or promotion of derived memory and illustration work. This distinguishes a provider delay from database lock contention or slow post-generation persistence.

## Error and Cancellation Behavior

Instrumentation is observational and must not alter generation behavior, retries, transaction boundaries, cancellation fencing, lease handling, or error classification.

- Phase failures are logged and rethrown.
- Cancellation and lease-loss errors retain their existing handling.
- Timer cleanup occurs in `finally` so no stall warnings appear after a phase ends.
- Logging failures must not fail turn generation; the existing logger interface is assumed non-throwing, matching current service usage.

## Privacy and Security

Diagnostics must never log:

- Player actions or generated narration
- Prompt or response bodies
- Scratchpads or private mechanics
- Retrieved memory content
- Credentials or provider authorization data
- Raw parser/validation messages

Counts, identifiers already used by current structured generation logs, phase names, model identifiers already present in provider logs, token counts, and elapsed durations are permitted.

## Testing

Extend the generation integration tests associated with `services/api/src/generation-service.ts`.

Tests will verify:

1. Successful generation emits ordered phase start/completion events for the path exercised.
2. A deliberately delayed phase emits a stall warning with correlation fields and elapsed timing.
3. Completion or failure clears the warning timer.
4. A failed phase emits a failure event and preserves existing generation failure behavior.
5. Logs do not contain fixture prompts, actions, narration, scratchpads, raw provider responses, or private markers.
6. Existing generation, recovery, cancellation, streaming, and commit tests continue to pass.

Use fake timers only where they cannot interfere with provider/server timing; otherwise use a configurable helper interval in a focused unit test while production remains fixed at 30 seconds.

## Success Criteria

For any future delayed turn, logs show the current phase, phase start time, periodic evidence that the worker is still waiting, phase completion/failure duration, total generation duration, and safe correlation identifiers. Operators can distinguish provider latency, context retrieval, orchestration, validation/recovery, optional illustration setup, and transactional commit delays without enabling unsafe debug logging.
