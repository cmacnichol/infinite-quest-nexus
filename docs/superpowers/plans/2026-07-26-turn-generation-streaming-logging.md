# Turn Generation Streaming and Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a browser-visible story stream from restarting when the Story Engine repairs or retries a turn, and add safe structured server logs that trace the complete durable turn-generation lifecycle.

**Architecture:** Treat the first `story_generation` provider call for a generation job as the only browser-visible stream. Internal recovery calls and later durable attempts remain buffered on the server, while the first provisional preview stays visible until a validated turn commits. Instrument generation jobs and the API SSE connection with correlated Pino events that contain identifiers, phase, counts, timing, and validation outcomes but never prompts, narration, raw provider output, private mechanics, or credentials.

**Tech Stack:** Node.js 22.13+, TypeScript 7, Fastify 5, PostgreSQL, Pino 10, Vitest 4, vanilla browser JavaScript

## Global Constraints

- Use **Infinite Quest Nexus** for the platform and **Infinite Quest** for the player-facing story experience.
- Preserve accepted turns as the authoritative recovery ledger; provisional output must never mutate campaign or Chronicle state.
- Keep text generation independent from optional illustration generation.
- A generation job may expose at most one provider response as a browser-visible live stream.
- Stream only the first `story_generation` call when `generation_jobs.attempts === 1`; buffer recovery and later durable attempts.
- Keep the first provisional preview visible until the validated authoritative turn replaces it.
- Do not add a database migration or a new browser/API contract for this focused fix.
- Never log prompt bodies, submitted actions, narration, choices, raw or rejected provider responses, private mechanics, scratchpads, credentials, authorization headers, cookies, or complete provider URLs.
- Log identifiers, operation names, attempt numbers, state transitions, response identifiers, finish reasons, token/count metadata, durations, and safe error codes only.
- Use two-space indentation and TypeScript for service changes.
- Every changed file receives associated test review; behavior changes require tests.
- Use test-driven development: observe each targeted test fail for the intended reason before adding production code.
- A PostgreSQL integration test that is skipped because `TEST_DATABASE_URL` is absent is not completed verification.
- Run `git diff --check` and review the complete diff before every commit.

---

## File and Interface Map

### Modified runtime files

- `services/api/src/generation-service.ts`
  - Selects the one provider request allowed to stream.
  - Preserves the original provisional output when hidden recovery fails.
  - Emits worker-side job, provider, validation, recovery, retry, stream-progress, commit, and failure events.
- `services/api/src/server.ts`
  - Emits API-side SSE connection and termination events using the Fastify request logger and request correlation ID.

### Modified tests

- `tests/integration/generation.integration.test.ts`
  - Extends the deterministic provider fixture to return SSE deltas.
  - Proves internal recovery is not streamed.
  - Proves a durable retry does not start a second visible stream or replace the retained provisional draft.
  - Verifies correlated generation log events omit private content.
- `tests/unit/server-security.test.ts`
  - Verifies the SSE route retains its security and correlation behavior after lifecycle logging is added.

### Modified operations documentation

- `docs/operations/logs-and-correlation.md`
  - Documents generation event names, shared fields, sampling, and prohibited content.
- `docs/operations/troubleshooting.md`
  - Adds an operator workflow for diagnosing apparent stream restarts by `generationJobId`, `jobAttempt`, and `storyOperation`.

### Interfaces

`callCampaignTextProvider` remains internal and keeps its existing call signature:

```ts
async function callCampaignTextProvider(
  pool: DatabasePool,
  provider: Awaited<ReturnType<typeof loadTextProvider>>,
  job: ClaimedJob,
  operation: StoryCostOperation,
  request: Parameters<typeof callTextProvider>[1]
): Promise<ProviderResult>
```

The generation service adds an internal safe context helper:

```ts
function generationLogContext(job: ClaimedJob, workerId?: string): {
  generationJobId: string;
  campaignId: string;
  providerProfileId: string;
  expectedTurnNumber: number;
  operationKind: ClaimedJob["operation_kind"];
  jobAttempt: number;
  workerId?: string;
}
```

No response schemas or browser event payloads change.

---

### Task 1: Reproduce the restart and enforce one visible stream per job

**Files:**

- Modify: `tests/integration/generation.integration.test.ts:20-83`
- Modify: `tests/integration/generation.integration.test.ts:840-955`
- Modify: `services/api/src/generation-service.ts:1528-1697`

**Interfaces:**

- Consumes: `ClaimedJob.attempts`, `ProviderRequest.onChunk`, `generation_jobs.partial_output`.
- Produces: the invariant that only the first job attempt's primary `story_generation` request receives `onChunk`.
- Produces: recovery attempts recorded in `generation_attempts` without exposing their partial text through `generation_jobs.partial_output`.

- [ ] **Step 1: Extend the deterministic provider fixture to support SSE**

Change the fixture reply type and request handler so a test can make the primary response stream while returning recovery responses as regular JSON:

```ts
type MockReply = {
  content: string;
  finishReason?: string;
  streamChunks?: string[];
};
```

Parse the outbound request before selecting the reply. When `providerRequest.stream === true` and `reply.streamChunks` is present, write compliant chat-completion SSE frames:

```ts
if (providerRequest.stream === true && reply.streamChunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of reply.streamChunks) {
    response.write(`data: ${JSON.stringify({
      id: crypto.randomUUID(),
      model: "deterministic-mock",
      choices: [{ delta: { content: chunk }, finish_reason: null }]
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: crypto.randomUUID(),
    model: "deterministic-mock",
    choices: [{ delta: {}, finish_reason: reply.finishReason || "stop" }],
    usage: { prompt_tokens: 700, completion_tokens: 220, total_tokens: 920 }
  })}\n\n`);
  response.end("data: [DONE]\n\n");
  return;
}
```

Keep the existing JSON response branch unchanged for non-streaming requests.

- [ ] **Step 2: Write a failing integration test for hidden internal recovery**

Add a test named `streams only the initial story request when validation starts an internal recovery`. In the test:

1. Set the shared mock provider configuration to `{"streaming":true}`.
2. Queue a streamed initial response whose complete narration contains mechanics leakage.
3. Queue a valid non-streaming cleanup response.
4. Run the job.
5. Inspect only the newly captured provider requests.
6. Assert the initial story request has `stream: true`.
7. Assert the mechanics-cleanup request does not have `stream: true`.
8. Assert the job completes and the committed narration is the cleaned narration.
9. Restore the provider configuration in `finally`.

Use synthetic strings that make accidental logging detectable:

```ts
const streamedDraft = validStory("Private streamed marker: she rolls a 17 and opens Location Gamma.");
const acceptedStory = validStory("Her practiced touch opens Location Gamma.");
```

Expected request assertions:

```ts
expect(turnRequests).toHaveLength(2);
expect(turnRequests[0]?.stream).toBe(true);
expect(turnRequests[1]?.stream).not.toBe(true);
```

- [ ] **Step 3: Run the focused integration test and verify RED**

Run:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database before running this test.' }
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "streams only the initial story request"
```

Expected: FAIL because the recovery request currently inherits `onChunk` and sends `stream: true`.

- [ ] **Step 4: Separate the buffered base request from the one visible streaming request**

In `executeGenerationJob`, replace the current streaming `baseRequest` with a non-streaming base plus a primary request:

```ts
const supportsStreaming = Boolean(
  provider.configuration
  && (provider.configuration.streaming === true || provider.configuration.streamingSupport === true)
);
const baseRequest = {
  systemPrompt: storySystemPrompt,
  input: storyInput
};
const primaryRequest = supportsStreaming && job.attempts === 1
  ? { ...baseRequest, onChunk }
  : baseRequest;

let result = await callCampaignTextProvider(
  pool,
  provider,
  job,
  "story_generation",
  primaryRequest
);
```

Keep `story_recovery` and `scene_coverage_rewrite` calls based on `baseRequest`. They must not receive `onChunk`.

- [ ] **Step 5: Run the focused integration test and verify GREEN**

Run the same command from Step 3.

Expected: PASS with one streamed provider request and one buffered recovery request.

- [ ] **Step 6: Write a failing integration test for durable retry behavior**

Add a test named `retains the first streamed preview and buffers later durable attempts`. Arrange:

1. Initial streamed response is incomplete or invalid.
2. Internal recovery response is also invalid, making the job `recoverable`.
3. Capture `getGenerationJob(...).partialOutput`.
4. Assert it contains the first streamed response and not the hidden recovery response.
5. Call `retryGeneration`.
6. Queue a valid response and run the same job again.
7. Assert the third provider request does not set `stream: true`.
8. Assert the job completes with the third response as the accepted turn.

Core assertions:

```ts
expect(recoverable.partialOutput).toContain("First visible streamed draft");
expect(recoverable.partialOutput).not.toContain("Hidden repair draft");
expect(turnRequests[2]?.stream).not.toBe(true);
```

- [ ] **Step 7: Run the durable-retry test and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "retains the first streamed preview"
```

Expected: FAIL because the recoverable transition currently overwrites `partial_output` with recovery output.

- [ ] **Step 8: Preserve the original provisional output at recoverable transitions**

In both recoverable updates:

- Remove the assignment that replaces `partial_output` with the hidden recovery or rewrite response.
- Remove the corresponding SQL parameter and renumber later placeholders.
- Continue persisting raw recovery output in `generation_attempts.raw_output`.
- Keep transport-failure partial output unchanged so interrupted primary streams remain diagnosable.

The output-limited/schema-repair update should set only terminal metadata:

```sql
UPDATE generation_jobs
   SET status = 'recoverable',
       provider_response_id = $3,
       provider_finish_reason = $4,
       error_code = $5,
       error_message = $6,
       recovery_metadata = recovery_metadata || $7::jsonb,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = now()
 WHERE id = $1
   AND owner_user_id = $2
   AND lease_owner = $8
```

Apply the same retention rule to the scene-coverage recoverable update.

- [ ] **Step 9: Run both restart regression tests and verify GREEN**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "streams only the initial story request|retains the first streamed preview"
```

Expected: both tests PASS.

- [ ] **Step 10: Commit the isolated behavior fix**

```powershell
git add tests/integration/generation.integration.test.ts services/api/src/generation-service.ts
git commit -m "Fix turn recovery streaming"
```

---

### Task 2: Add safe worker-side turn-generation lifecycle logs

**Files:**

- Modify: `tests/integration/generation.integration.test.ts`
- Modify: `services/api/src/generation-service.ts:1-75`
- Modify: `services/api/src/generation-service.ts:217-243`
- Modify: `services/api/src/generation-service.ts:556-567`
- Modify: `services/api/src/generation-service.ts:1056-1077`
- Modify: `services/api/src/generation-service.ts:1386-1772`

**Interfaces:**

- Consumes: shared `logger` from `packages/logger/src/index.ts`.
- Produces: safe structured Pino events keyed by `generationJobId`, `campaignId`, `jobAttempt`, and `storyOperation`.
- Preserves: existing provider transport error logging and all job state transitions.

- [ ] **Step 1: Write a failing lifecycle-log integration test**

Import the shared logger:

```ts
import { logger } from "../../packages/logger/src/index.js";
```

Add a test named `logs correlated generation lifecycle and recovery metadata without private story content`. Spy on `logger.info`, `logger.warn`, and `logger.error`, then run the mechanics-cleanup scenario from Task 1.

Filter calls by event name and assert this ordered subset exists:

```ts
expect(events).toEqual(expect.arrayContaining([
  expect.objectContaining({
    event: "turn_generation_claimed",
    generationJobId: job.id,
    campaignId: imported.campaignId,
    jobAttempt: 1
  }),
  expect.objectContaining({
    event: "turn_generation_provider_started",
    storyOperation: "story_generation",
    streaming: true
  }),
  expect.objectContaining({
    event: "turn_generation_recovery_started",
    recoveryKind: "mechanics_cleanup"
  }),
  expect.objectContaining({
    event: "turn_generation_provider_started",
    storyOperation: "story_recovery",
    streaming: false
  }),
  expect.objectContaining({
    event: "turn_generation_completed",
    generationJobId: job.id,
    resultTurnId: expect.any(String)
  })
]));
```

Serialize all captured arguments and assert exclusion:

```ts
expect(serializedLogs).not.toContain("Private streamed marker");
expect(serializedLogs).not.toContain("Private synthetic continuity marker");
expect(serializedLogs).not.toContain(credentialSecret);
expect(serializedLogs).not.toContain(streamedDraft);
expect(serializedLogs).not.toContain(acceptedStory);
```

Restore every spy in `finally`.

- [ ] **Step 2: Run the lifecycle-log test and verify RED**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts -t "logs correlated generation lifecycle"
```

Expected: FAIL because the generation service currently emits only provider transport errors.

- [ ] **Step 3: Add the logger import and safe common context**

Add:

```ts
import { logger } from "../../../packages/logger/src/index.js";
```

Implement `generationLogContext(job, workerId?)` with only:

- `generationJobId`
- `campaignId`
- `providerProfileId`
- `expectedTurnNumber`
- `operationKind`
- `jobAttempt`
- optional `workerId`

Do not include `job.action`, prompt snapshots, context scopes, orchestration data, or partial output.

- [ ] **Step 4: Log job claim, explicit retry, start, and terminal state**

Refactor `claimGeneration` to store the transaction result before returning it. When a job is claimed, emit:

```ts
logger.info({
  event: "turn_generation_claimed",
  ...generationLogContext(claimed, workerId),
  leaseSeconds
});
```

At the start of `executeGenerationJob`, capture `const generationStartedAt = Date.now()` and emit `turn_generation_started`.

After `commitStory` returns its `turnId`, emit:

```ts
logger.info({
  event: "turn_generation_completed",
  ...generationLogContext(job, workerId),
  resultTurnId: turnId,
  providerResponseId: result.responseId || null,
  finishReason: result.finishReason || null,
  durationMs: Date.now() - generationStartedAt
});
```

After a failed-state update, emit `turn_generation_failed` with `errorCode`, `durationMs`, and `transportTimedOut`; do not log the exception message.

Update `retryGeneration` to return `campaign_id`, `attempts`, and `operation_kind` internally, emit `turn_generation_requeued`, then preserve the public return shape `{ id, status }`.

- [ ] **Step 5: Log each provider operation without request content**

In `callCampaignTextProvider`:

1. Capture `startedAt`.
2. Emit `turn_generation_provider_started`.
3. Call `callTextProvider`.
4. Record cost as today.
5. Emit `turn_generation_provider_completed`.
6. Preserve the existing `logProviderTransportError` call on failure.
7. Emit `turn_generation_provider_failed` with only safe error classification.

Started fields:

```ts
{
  event: "turn_generation_provider_started",
  ...generationLogContext(job),
  storyOperation: operation,
  providerType: provider.providerType,
  requestedModel: provider.model,
  streaming: typeof request.onChunk === "function",
  recovery: Boolean(request.recoveryInput)
}
```

Completed fields additionally include:

- `providerResponseId`
- `finishReason`
- `outputLimited`
- `modelInstanceId`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `durationMs`

Never log `request`, `request.input`, `request.systemPrompt`, `request.recoveryInput`, `request.rejectedResponse`, or `result.content`.

- [ ] **Step 6: Log validation and recovery decisions**

After parsing the primary response, emit `turn_generation_validation_completed` with:

- `storyOperation: "story_generation"`
- `valid`
- `outputLimited`
- `validationCode`
- `validationErrorCount`
- `attemptNumber`

Before invoking recovery, emit `turn_generation_recovery_started` at warn level with:

- `firstReason`
- `recoveryKind`
- `initialAttemptNumber`
- `validationErrorCount`

After recovery parsing, emit another `turn_generation_validation_completed` for `story_recovery`.

When the job becomes recoverable, emit `turn_generation_recoverable` with `errorCode`, `attemptCount`, and `durationMs`.

For scene coverage, emit:

- `turn_generation_scene_coverage_completed`
- `turn_generation_recovery_started` with `recoveryKind: "scene_coverage_rewrite"` when rewriting
- `turn_generation_recoverable` with `errorCode: "scene_coverage"` when the rewrite still fails

Log counts and codes, never missing beat text, contradictions, submitted action, or narration.

- [ ] **Step 7: Add sampled stream-progress and persistence-failure logs**

Track:

```ts
let lastStreamLogAt = 0;
let lastStreamLogChars = 0;
let lastStreamPersistWarningAt = 0;
```

After a successful `partial_output` update, emit `turn_generation_stream_progress` only for the first update or when at least five seconds or 4,096 additional characters have elapsed. Fields:

- common generation context
- `storyOperation: "story_generation"`
- `accumulatedChars`
- `narrationChars`
- `streamDurationMs`

Change the ignored persistence catch to `catch (error)` and emit `turn_generation_stream_persist_failed` no more than once every five seconds. Include only `errorName` and a string `errorCode` when present; omit `error.message`.

Do not log every provider chunk.

- [ ] **Step 8: Run the lifecycle-log test and verify GREEN**

Run the command from Step 2.

Expected: PASS with correlated events and no private strings.

- [ ] **Step 9: Run the entire generation integration file**

Run:

```powershell
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts
```

Expected: all generation integration cases PASS against the real test database.

- [ ] **Step 10: Commit worker-side observability**

```powershell
git add tests/integration/generation.integration.test.ts services/api/src/generation-service.ts
git commit -m "Log turn generation lifecycle"
```

---

### Task 3: Add correlated API SSE lifecycle logs

**Files:**

- Modify: `tests/unit/server-security.test.ts`
- Modify: `services/api/src/server.ts:745-784`

**Interfaces:**

- Consumes: Fastify `request.id`, the shared Pino `logger`, and generation `jobId`.
- Produces: one connection event and one terminal/disconnection event per SSE request.
- Preserves: existing SSE response headers and payload schema.

- [ ] **Step 1: Add a failing terminal-SSE lifecycle test**

Import `logger` into `tests/unit/server-security.test.ts` and add a test named `logs one correlated lifecycle for a terminal generation stream`.

Use a UUID job ID and a pool stub that:

- returns the initial owner for the `users` lookup;
- returns one completed generation row for `getGenerationJob`;
- throws on every unexpected query.

Spy on `logger.info`, inject `GET /api/v1/generation-jobs/:jobId/stream`, and assert:

```ts
expect(response.statusCode).toBe(200);
expect(response.headers["content-type"]).toContain("text/event-stream");
expect(response.headers["cache-control"]).toBe("no-cache");

const lifecycleLogs = loggerInfo.mock.calls
  .map(([fields]) => fields)
  .filter((fields: any) => String(fields?.event || "").startsWith("turn_generation_stream_"));

expect(lifecycleLogs).toEqual([
  expect.objectContaining({
    event: "turn_generation_stream_connected",
    generationJobId: jobId,
    correlationId: expect.any(String)
  }),
  expect.objectContaining({
    event: "turn_generation_stream_closed",
    generationJobId: jobId,
    correlationId: lifecycleLogs[0]?.correlationId,
    finalStatus: "completed",
    snapshotsSent: 1
  })
]);
```

Serialize the log calls and assert they do not contain the fixture action, partial output, or partial narration. Restore the logger spy and close the app in `finally`.

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
pnpm exec vitest run tests/unit/server-security.test.ts
```

Expected: FAIL because the SSE route has no lifecycle events.

- [ ] **Step 3: Instrument connection, terminal state, error, and client close**

At route entry, capture:

```ts
const streamStartedAt = Date.now();
let snapshotsSent = 0;
let finalStatus = "client_closed";
```

Import the shared logger alongside `createLoggerOptions`, then emit:

```ts
logger.info({
  event: "turn_generation_stream_connected",
  correlationId: request.id,
  generationJobId: jobId
});
```

Increment `snapshotsSent` after every successful `reply.raw.write`.

Set `finalStatus` to the observed terminal job status before breaking. If the polling loop catches an error, set it to `"stream_error"` and use `logger.warn` with only `correlationId`, `generationJobId`, `errorName`, and safe `errorCode`.

Use a `finally` block to emit exactly one closure event:

```ts
logger.info({
  event: "turn_generation_stream_closed",
  correlationId: request.id,
  generationJobId: jobId,
  finalStatus,
  snapshotsSent,
  durationMs: Date.now() - streamStartedAt
});
```

Do not include the SSE payload, action, partial output, partial narration, or error message.

- [ ] **Step 4: Run the focused unit test and verify GREEN**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Run server and generation-related unit tests**

Run:

```powershell
pnpm exec vitest run tests/unit/server-security.test.ts tests/unit/story-player-ui.test.ts tests/unit/providers.test.ts tests/unit/logger.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit SSE lifecycle logging**

```powershell
git add tests/unit/server-security.test.ts services/api/src/server.ts
git commit -m "Log turn stream connections"
```

---

### Task 4: Document the diagnostic workflow and perform final verification

**Files:**

- Modify: `docs/operations/logs-and-correlation.md`
- Modify: `docs/operations/troubleshooting.md`

**Interfaces:**

- Consumes: event and field names introduced in Tasks 2 and 3.
- Produces: an operator procedure that can distinguish primary generation, internal recovery, durable retry, SSE reconnect, and terminal commit without inspecting story content.

- [ ] **Step 1: Document the generation event vocabulary**

Add a “Turn generation” section to `docs/operations/logs-and-correlation.md` listing:

- `turn_generation_claimed`
- `turn_generation_started`
- `turn_generation_provider_started`
- `turn_generation_provider_completed`
- `turn_generation_provider_failed`
- `turn_generation_stream_progress`
- `turn_generation_stream_persist_failed`
- `turn_generation_validation_completed`
- `turn_generation_scene_coverage_completed`
- `turn_generation_recovery_started`
- `turn_generation_recoverable`
- `turn_generation_requeued`
- `turn_generation_completed`
- `turn_generation_failed`
- `turn_generation_stream_connected`
- `turn_generation_stream_closed`

Document the primary correlation fields:

```text
generationJobId
campaignId
workerId
jobAttempt
storyOperation
providerProfileId
providerResponseId
correlationId
```

State that `turn_generation_stream_progress` is sampled and reports character counts rather than text.

- [ ] **Step 2: Add the apparent-restart troubleshooting sequence**

Add a “Streaming story appears to restart” section to `docs/operations/troubleshooting.md`:

1. Filter logs by `generationJobId`.
2. Order events by timestamp.
3. Confirm only one `turn_generation_provider_started` event has `streaming: true`.
4. Check whether `turn_generation_recovery_started` follows primary validation.
5. Check whether `turn_generation_requeued` increments `jobAttempt`.
6. Compare `turn_generation_stream_connected` and `turn_generation_stream_closed` counts to identify browser/network reconnects.
7. Confirm the sequence terminates in exactly one of `turn_generation_completed`, `turn_generation_recoverable`, or `turn_generation_failed`.

Explain that a recovery provider call is expected after invalid output, but it must report `streaming: false` and must not replace the browser preview.

- [ ] **Step 3: Run static checks**

Run:

```powershell
pnpm check
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Run the complete unit suite**

Run:

```powershell
pnpm test:unit
```

Expected: all unit tests PASS.

- [ ] **Step 5: Run the complete PostgreSQL-backed integration suite**

Run with a real isolated database:

```powershell
if (-not $env:TEST_DATABASE_URL) { throw 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database before running integration tests.' }
pnpm test:integration
```

Expected: all integration tests PASS. Any skip must be identified and justified; absence of `TEST_DATABASE_URL` does not satisfy this step.

- [ ] **Step 6: Review logging privacy and event cardinality**

Inspect the complete diff and verify:

- No log object includes `action`, `input`, `systemPrompt`, `recoveryInput`, `rejectedResponse`, `content`, `partialOutput`, `partialNarration`, `narration`, `scratchpad`, or credentials.
- Streaming progress is sampled rather than emitted per chunk.
- Every provider start has one completed or failed event.
- Every claimed job reaches one completed, recoverable, or failed event.
- The SSE route emits one connected and one closed event per connection.
- No browser payload or database schema changed.

- [ ] **Step 7: Commit documentation and final verification adjustments**

```powershell
git add docs/operations/logs-and-correlation.md docs/operations/troubleshooting.md
git commit -m "Document turn generation diagnostics"
```
