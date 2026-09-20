# Task 4B2 report: durable v2 Story response contracts and invocation persistence

## Scope delivered

The v2 response-contract persistence path now stores a prompt-independent frozen closure and a separate immutable invocation audit. A preset closure contains only its selected route basis hash, exact catalog schema, admitted operation key, and queue authority. Each reservation receives the trusted effective operation prompt, derives and verifies that invocation's plan, and persists its own prompt hash, plan hash, body hash, and selected candidate model.

The repository reads and writes version-discriminated queued policies, frozen closures, and invocation audits. It preserves v1 readers, policy hashes, audit IDs, and historical state behavior. A v2 preset reservation requires the saved enqueue-time route basis as well as the matching supplied basis and derived plan. Direct verified Models use exact frozen model authority and deliberately carry no preset basis or plan.

`responseContractInvocationLedgerLimitV2` exports the finite job-wide limit of 24 durable logical invocation entries. This is a fail-closed accounting policy shared by v1 and v2. Prompt-distinct repairs and persisted logical-attempt history consume the same budget; this work does not claim that arbitrary repeated recovery fits within it. Physical provider-route attempts remain Task 5 data.

Prepared-response failure evidence now accepts version 2 only when it names a dispatched or completed v2 invocation whose request payload hash is the exact hash of the stored request body. Completed response checkpoints retain their existing proof requirement under v2 and reject missing or mismatched invocation evidence.

## TDD evidence

RED was recorded before implementing the versioned helpers:

```powershell
corepack pnpm exec vitest run tests/unit/generation-response-contract-persistence.test.ts --reporter=dot
```

It failed in two new tests because `readQueuedResponsePolicyVersioned` did not exist (`TypeError: ... is not a function`).

The focused unit GREEN command was:

```powershell
corepack pnpm exec vitest run tests/unit/generation-response-contract.test.ts tests/unit/generation-response-contract-persistence.test.ts tests/unit/generation-response-contract-preflight.test.ts tests/unit/generation-response-contract-operation-matrix.test.ts tests/unit/preset-response-format.test.ts --reporter=dot
```

Result: 5 files, 53 tests passed.

Focused real PostgreSQL persistence verification was:

```powershell
corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-response-contract.integration.test.ts --reporter=dot
```

Result: 1 file, 18 tests passed. It covers primary/repair distinct plans behind one schema key, cross-plan and unrelated-model rejection, duplicate replay, 24-entry capacity exhaustion, v2 body-failure evidence, stale/cross-owner lease denial followed by actual reclaim, rehashed schema rejection, missing/mismatched checkpoint rejection, and direct Model persistence without route basis or plan.

TypeScript verification passed:

```powershell
corepack pnpm exec tsc -p tsconfig.json --noEmit
```

The final related PostgreSQL verification was:

```powershell
corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/generation-response-contract.integration.test.ts tests/integration/generation-response-contract-workflow.integration.test.ts tests/integration/generation-response-contract-operations.integration.test.ts tests/integration/generation-response-contract-failures.integration.test.ts tests/integration/generation-response-contract-projection.integration.test.ts --reporter=dot
```

Result: 5 files, 32 tests passed. `git diff --check` also passed before commit.

## 4B3 handoff

- Read queued policy with `readQueuedResponsePolicyVersioned` and identify it with `queuedResponsePolicyVersionedHash`. Do not feed a v2 value to the v1 reader or hash helper.
- Read frozen closure with `readFrozenResponseContractsVersioned`. A v2 preset contract is intentionally not a prepared request contract and contains no `planHash`.
- For each v2 call, use `bindFrozenResponseContractInvocationV2` with the v2 invocation key, concrete operation, persisted route basis, independently trusted operation prompt, and the plan derived from that prompt. For a verified Model, pass no route basis or plan and retain the exact frozen model authority.
- Persist the returned `AttemptResponseContractAuditV2` through `reserveResponseContractInvocation` version 2. The audit must contain the request-body hash, operation-prompt hash, requested model, and either matching route/plan hashes for a preset or null route/plan hashes for a Model. Mark dispatched and complete with the same versioned invocation value.
- Treat `responseContractInvocationLedgerLimitV2` exhaustion as a deliberate response-contract failure and ensure every worker auxiliary catch propagates it as a v2 schema/contract error rather than retrying around it.
- V2 failure records use `version: 2` and require a matching dispatched/completed v2 invocation plus the exact body hash. They are private orchestration evidence.

## Deferred gates

Task 4B3 still owns runtime queue/worker/executor adoption and schema-error propagation in all auxiliary catches. This slice leaves native production admission disabled and does not make provider calls, change UI or authoring/source paths, implement physical provider-route worker claim fencing, or add fallback behavior. Task 5 remains responsible for physical route-attempt records.
