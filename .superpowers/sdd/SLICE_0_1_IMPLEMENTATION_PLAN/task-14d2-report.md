# Task 14d2 implementation report

## Commit scope

- Base: `a76575695d78eadb3acfcc7465dd6bf487fa4e61`
- Commit summary: `feat(database): add provider adapters`
- Scope is additive PostgreSQL provider, prompt, and cost repositories; one runtime-private credential/transport adapter; and focused pure/real-PostgreSQL tests. No routes, runtime composition, live consumers, legacy services, frozen 14d1 contracts, UI, migrations, or removals changed.

## Implemented adapters

- `provider-repository.ts` implements owner-scoped profile CRUD/default selection, health transitions, direct role resolution, and explicit embedding fallback. Repositories bind to a caller-owned `DatabaseClient`; they never begin or commit a transaction.
- Per-owner/per-role advisory transaction locks serialize default selection. Selected defaults must exist in the owner scope, match the requested role, and remain enabled.
- Provider writes normalize trailing URL separators, validate the 512-token text output reserve, validate Sogni/Sogni SDK configuration before safe projection, and reject disabled defaults.
- Profile updates preserve Chronicle behavior by clearing stale embedding data and inserting or version-bumping the owner/campaign-scoped `embed_campaign` job.
- Public profile rows are built only through `toSafeProviderConfiguration`, expose credential presence as a boolean, and omit encrypted fields and stored health diagnostics.
- `prompt-repository.ts` implements owner/application/campaign-scoped list, preview, save, reset, and deterministic snapshot loading. Snapshot precedence is campaign, application, then shipped; each entry carries a hash/source and the version retains the established runtime-key protocol fingerprint.
- `cost-repository.ts` uses an opaque `WeakMap` transaction carrier, so writes accept only a context constructed from a caller-owned database client. Reads and attribution retain owner/campaign/turn filters, category totals, currency separation, and idempotent provider/local call semantics.
- `provider-credential-transport-adapter.ts` is runtime-private. It encrypts before persistence, decrypts only immediately before transport use, keeps transient candidate credentials outside application types, reuses the injected pinned `ProviderTransport`, returns opaque credential references only, maps failures to stable diagnostics, and replaces provider errors with a safe public inventory error.

## Credential and transport audit

- Encrypted credential reads/writes are deliberately not exported from the database package barrel. Only the runtime-private adapter imports them directly.
- Application profile views, model inventories, leases, diagnostics, safe errors, and test snapshots contain no plaintext, ciphertext, nonce, authentication tag, key version, or encryption secret.
- Stored and unsaved configurations pass provider-specific validation before projection onto the frozen 14d1 safe allowlist.
- The runtime adapter does not create an HTTP client or bypass the network policy; discovery receives the existing injected pinned transport.
- No credential or provider exception is logged by the new code.

## Test coverage

- Pure tests cover provider-specific validation before redaction, opaque caller-owned cost transaction contexts, runtime credential encryption/decryption containment, public/lease exclusion, stable health recording, and reuse of the injected pinned transport.
- Real-PostgreSQL tests cover owner invisibility, normalized/redacted profile reads, credential presence without material, concurrent default changes, role/model resolution, explicit-only text fallback for embeddings, health degradation/unavailability/recovery, Chronicle embedding invalidation/requeue, deterministic prompt-version changes, cross-owner campaign rejection, and cost owner/campaign/turn/category/currency isolation.
- The initial focused run was red because the new adapter modules did not yet exist. The first PostgreSQL run then exposed an invalid Zod `.omit()` on a refined schema; parsing the complete credential-free input through the established refined schema fixed the adapter without weakening validation.

## Verification

- Baseline: `pnpm check`, `pnpm build`, 109 unit files / 1,246 tests, and 31 integration files / 337 tests passed before implementation.
- Focused final unit: 1 file, 3 tests passed.
- Focused final real PostgreSQL: 1 file, 6 tests passed.
- `pnpm check`: passed, including repository-boundary and data-safety checks.
- `pnpm build`: passed, including both web builds.
- Full unit: 110 files, 1,249 tests passed.
- Full integration: 32 files, 343 tests passed.
- `git diff --check`: passed before report creation; staged checks and `pjm precheck` are run immediately before commit.

## Handoff concerns

- Production remains on the legacy provider, prompt, and cost services until Task 14d3 performs the atomic cutover. The new adapters have no live caller or composition change in this task.
- Mutating repositories require the surrounding 14d3 composition to supply and own the transaction lifecycle. Passing a client outside an active command transaction would violate the intended use even though PostgreSQL cannot expose transaction state through the `PoolClient` type.
- Prompt protocol compatibility intentionally follows the established runtime prompt-key set; changing non-runtime authoring/import/illustration prompts changes their snapshot hashes but not the story model-chain protocol fingerprint.
- Candidate inventory has no credential field in the frozen application contract. The adapter provides a separate runtime-private candidate-discovery method for a transient credential; 14d3 must call that boundary rather than adding the value to application types.
