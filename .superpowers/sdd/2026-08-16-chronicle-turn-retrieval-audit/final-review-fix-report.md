# Chronicle Final-Review Repair Report

Date: 2026-08-17
Base revision: `43fb6d4`

## Scope and root causes

The final review found three connected truthfulness defects in the Chronicle
retrieval audit. The runtime provider adapter resolved a profile/default model
without receiving the campaign's configured embedding model, so the audit could
misidentify the model used for execution. The Legacy path also called a
successful provider or cache-backed query semantic even when it had no current,
compatible candidate embedding to rank; it changed relevance accounting despite
contributing no semantic selection. Finally, the audit-label schema rejected
normal model identifiers containing spaces, `+`, `@`, and provider/model paths.

The repair leaves accepted turns immutable, leaves fallback selection and token
budgets unchanged, preserves provider/cache trace, and exposes no endpoint,
credential, raw query/action/narration, provider response, profile ID, or
fingerprint through audit fields.

## Strict TDD evidence

RED was captured before the production changes:

- `tests/unit/chronicle-retrieval-audit-contract.test.ts`: 1/8 failed because
  the former label regex rejected valid `+`, `@`, and spaced model labels.
- `tests/unit/chronicle-runtime-adapter.test.ts`: 2/13 failed because the
  resolver and binding did not receive the configured model; audit projection
  retained the profile/default model.
- With `TEST_DATABASE_URL` privately derived from `.env.test.local` for the
  isolated `infinitequest-integration-postgres` instance, the added Legacy
  regression failed (7/8 passed): `provider.model` was absent before model
  threading.
- After the minimal model-threading change, the same real-PostgreSQL case was
  RED again (7/8 passed): the no-fresh-candidate path had changed relevance and
  `semanticRelevance` compared with semantic-disabled Legacy. This established
  the required semantic-specific behavioral failure.

The production repair threads `embedding_model` through the Chronicle
transaction port, runtime binding, and provider adapter; the adapter preserves
that execution-selected model in the resolution used to build audit provenance.
Legacy retrieval now treats zero fresh/current compatible candidate scores as a
complete `lexical_only` fallback with `semantic_retrieval_unavailable`, after
retaining the successful provider/cache query trace and health attribution. The
safe-label validator now trims non-empty values through 500 characters, permits
ordinary model names, and rejects controls, URI schemes, and endpoint-like
hosts.

GREEN evidence:

- Focused unit suites: 27/27 passed across audit-contract, runtime-adapter, and
  memory-inventory documentation-link tests.
- Real PostgreSQL query cache/Legacy regression: 8/8 passed.
- Real PostgreSQL chunk retrieval: 14/14 passed.
- Real PostgreSQL provider adapters: 8/8 passed.
- `pnpm check`: exit 0.

The documentation-link test is a valid GREEN characterization: the linked
implementation plan already existed as task-owned untracked content, so no
destructive artificial RED was created. The plan now accurately marks Tasks
1–7 complete and keeps controller-owned Task 8 matrix work unchecked.

## Verification boundary

This repair deliberately did not run the complete unit suite, full isolated
PostgreSQL matrix, retrieval evaluators, or long-campaign final review; those
remain the controller-owned Task 8 verification steps. Final scoped diff and
whitespace checks are recorded with the repair commit.
