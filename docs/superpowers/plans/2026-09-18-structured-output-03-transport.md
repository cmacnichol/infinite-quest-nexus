# Structured output 03: serialization and transport implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra implementer and fresh Terra reviewers.

**Goal:** Send the selected schema and compatible routing in exactly the bytes that are budgeted and hashed, with no hidden downgrade.

**Architecture:** Add a discriminated prepared response contract to the canonical serializer. Preserve the old serializer branch when the contract is absent. Transport sends prepared bytes once and returns finite classified failures.

**Tech Stack:** TypeScript, Vitest, existing OpenAI-compatible streaming transport.

**Spec:** [Index](2026-09-18-structured-output.md). Depends on patches 01–02.

## Files and interfaces

- Modify `packages/story-engine/src/provider-request.ts`, `providers.ts`; create `packages/story-engine/src/provider-response-format.ts` for schema/routing preparation and finite error classification if extraction keeps transport code focused.
- Tests: `tests/unit/providers.test.ts`, `provider-request-budget.test.ts`, `provider-transport-security.test.ts`; create `tests/unit/provider-response-format.test.ts`.
- Read `packages/story-engine/src/provider-transport.ts`, `provider-response.ts` before changing HTTP/SSE handling. Retain body limits, endpoint validation and secret isolation.

```ts
type PreparedResponseContract =
  | Readonly<{ version: 1; mode: "json_object";
      operation: ResponseSchemaOperation; streaming: boolean;
      forbidFormatFallback: true }>
  | Readonly<{ version: 1; mode: "json_schema";
      operation: ResponseSchemaOperation; streaming: boolean;
      schemaVersion: string;
      schemaHash: string; schemaName: string;
      schema: Readonly<Record<string, unknown>>;
      providerRoutingSlugs: readonly string[];
      routeConfigHash: string; adapterProtocol: "text-schema-adapter-v1";
      forbidFormatFallback: true }>;
```

Add optional `responseContract` to `ProviderRequest` and canonical serialization options. Absence invokes historical behavior, including existing `responseFormat` boolean handling; reject contradictory legacy options plus a new contract. Schema registry resolution and hash verification happen before serialization, not by trusting arbitrary request JSON.

The contract's `streaming` must equal the actual presence of `request.onChunk`; reject mismatch before sending. Recovery serialization here means provider-backed explicit Retry/continuity/choice/extension requests, never the local deterministic `repair_format` operation.

## Task 1: canonical payload and budget

- [ ] RED: serialize otherwise identical legacy, new JSON-object and strict requests. Assert strict body contains schema/name/strict flag, exactly matches dispatched bytes, changes payload hash, and includes schema/routing overhead in count. Preserve historical 144-case serializer/hash compatibility fixtures referenced in the merged report.
- [ ] OpenRouter strict payload adds `provider: { require_parameters: true, only: providerRoutingSlugs }`. Endpoint restrictions must be nonempty for verified routes; endpoint IDs must be provider-routing identifiers verified by the probe, not guessed display names. Preserve compatible existing routing if later main adds it; reject conflicts instead of widening providers. Verify current OpenRouter routing field semantics before implementation.
- [ ] Non-OpenRouter verified adapter emits the schema but no OpenRouter `provider` field. Native LM Studio remains historical and cannot accept this contract accidentally.
- [ ] Make strict schema mode part of both normal and recovery serialization. Count the complete serialized request and include constraints in output-feasibility accounting; fail before dispatch when the additional schema exceeds the budget.

```ts
const body = JSON.parse(strictPrepared.body);
expect(body.response_format.type).toBe("json_schema");
expect(body.response_format.json_schema.strict).toBe(true);
expect(body.provider.require_parameters).toBe(true);
expect(strictPrepared.payloadHash).not.toBe(legacyPrepared.payloadHash);
expect(sentBody).toBe(strictPrepared.body);
```

Use existing real-builder test helpers and deterministic mock transport for `sentBody`, not a test-only serializer.

## Task 2: bounded failures and streaming

- [ ] RED: HTTP schema-not-supported/invalid-schema/routing-no-endpoint failures, malformed 200, refusal-only response, truncated SSE, timeout after headers and output limit. Assert new-contract request count is exactly one after dispatch; preflight failures remain zero. Preserve response ID, actual body/hash and partial bytes for recovery.
- [ ] Implement finite internal categories: `provider_schema_unsupported`, `provider_schema_invalid`, `provider_route_unavailable`, `provider_refusal`; retain existing timeout, transport, invalid JSON and invalid schema distinctions. Prefer provider code/status; unknown errors remain generic transport/provider errors, never guessed successful fallbacks. Never publish raw error bodies.
- [ ] Disable the existing regex-triggered format fallback for any `responseContract`, including auto-selected JSON-object mode. Keep historical absent-contract tests unchanged. No automatic second request after a schema rejection, refusal or partial stream.
- [ ] Verify streamed narration extraction and final parsing with schema mode. A complete length-finished valid object follows existing validation semantics; an incomplete one stays recoverable. Do not call a partial JSON chunk an accepted object.
- [ ] Run `corepack pnpm exec vitest run tests/unit/providers.test.ts tests/unit/provider-request-budget.test.ts tests/unit/provider-response-format.test.ts tests/unit/provider-transport-security.test.ts`; capture RED/GREEN and type checks. Commit scoped changes after diff review.

## Exit gate

Strict/new-auto paths have an enforceable one-call boundary, historical calls retain byte compatibility, and prepared/hash/budget/transport all agree. The feature remains unselected by production jobs until patch 04 supplies trusted durable contracts.
