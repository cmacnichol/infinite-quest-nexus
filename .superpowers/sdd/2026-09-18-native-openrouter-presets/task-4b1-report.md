# Task 4B1: v2 Story contract prerequisites

## Delivered

- Added a typed Story operation-to-v2-invocation mapping for RPG assessment, before/after triggers, scene coverage, and distinct event coverage. Historical v1 auxiliary behavior remains unchanged.
- Added v2 verification-registry parsing and capability resolution, kept separate from v1 records, and proved file-loaded exact Story evidence reaches direct-model admission.
- Extended the provider serializer to validate v2 catalog contracts. Direct-model v2 requests preserve verified OpenRouter route restrictions and `require_parameters`; preset-trusted v2 requests fail closed until the frozen route executor exists.
- Bound preset v2 response contracts against the saved route basis, actual derived plan, and trusted operation prompt before request serialization.

## Verification

Passed with the task-local Corepack shim:

```text
corepack pnpm exec vitest run tests/unit/provider-schema-verification.test.ts tests/unit/generation-response-contract-operation-matrix.test.ts tests/unit/provider-response-contract-transport.test.ts --reporter=dot
# 3 files, 84 tests passed

corepack pnpm exec tsc -p tsconfig.json --noEmit
git diff --check
```

The transport suite logs exercised mocked transport failures; the suite passed.

## Deferred to Task 4B2

- Versioned v2 queued policy and frozen closure persistence.
- Per-invocation plan-bound v2 reservation/audit schema and reclaim/Keep handling.
- Worker closure construction for verified Models versus trusted Presets.
- Dedicated PostgreSQL append, replacement, reclaim, and Keep coverage.
- Native production admission remains disabled. No provider calls, UI changes, pushes, PRs, or main integration occurred.
