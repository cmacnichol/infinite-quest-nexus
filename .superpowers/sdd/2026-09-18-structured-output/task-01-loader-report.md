# Task 01 loader verification

## Scope

Hardened `services/runtime/src/provider-schema-verification.ts` and its focused unit suite only. The loader now accepts exact bounded verification records, validates production SHA-256 identities and route-config/schema hashes, rejects unresolved model aliases, enforces concrete OpenRouter routing identifiers, and freezes every returned record and routing array. OpenAI-compatible records may have no routes and reject OpenRouter routing fields.

The configured file is bounded before allocation (1 MiB), contains at most 1,000 records, and normalizes unreadable, oversized, malformed, and invalid configuration to `TEXT_SCHEMA_VERIFICATION_FILE is invalid.`. An omitted path returns the immutable empty registry. The optional injected clock rejects future verification times while retaining expired records for the resolver to classify. The registry digest is the SHA-256 of the exact input bytes.

## Evidence

- RED: `corepack pnpm exec vitest run tests/unit/provider-schema-verification.test.ts` exited 1 with 10 expected failures of the new strict boundary assertions (unbounded/extra fields, missing-file diagnostics, and invalid routing). The pre-existing implementation had not yet enforced those cases.
- GREEN: `corepack pnpm exec vitest run tests/unit/provider-schema-verification.test.ts` exited 0: 1 file, 19 tests passed.
- Type check: `corepack pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --types node services/runtime/src/provider-schema-verification.ts` exited 0.
- Whitespace: `git diff --check -- services/runtime/src/provider-schema-verification.ts tests/unit/provider-schema-verification.test.ts` exited 0.

No PostgreSQL, browser, or live-provider checks apply to this pure filesystem loader; none were run. Runtime composition and generation dispatch remain owned by the coordinating task.
