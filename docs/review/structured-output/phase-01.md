# Structured output phase 01 handoff

Patch 01 preserves bounded OpenRouter `supported_parameters` advertisements for text inventory only. Image and embedding discovery remains unchanged. Missing or malformed advertisements remain unknown, and no model-name or JSON-mode inference is used.

`textResponseFormatPolicy` is a closed safe configuration value. Its absence remains absent in stored historical configuration, while selection resolves an absent policy as `legacy`; this preserves existing configuration fingerprints and serializer behavior.

The process-local capability cache is bounded to 1,000 LRU entries, has a 24-hour TTL, single-flights matching discovery, and caches failed discovery as unknown. It is intentionally nonportable: process restart causes new-job metadata discovery, never a positive guess. Verification records are operator JSON selected by `TEXT_SCHEMA_VERIFICATION_FILE`; missing means no verified routes. Records are bounded to 1 MiB/1,000 entries, expire within 30 days, and configuration startup rejects malformed or future records. The digest is safe to compare across roles; restart reloads the immutable file.

Eligibility requires an exact endpoint, model, route hash, adapter protocol, operation, schema, streaming mode, advertised support, and current record. OpenRouter additionally requires `structured_outputs`; aliases/presets remain unknown. Story eligibility preserves native open tracker objects. Patch 04 owns durable job selections and worker preflight; this patch changes no generation dispatch.

Focused GREEN evidence: `corepack pnpm exec vitest run tests/unit/provider-response-format.test.ts tests/unit/provider-capability-cache.test.ts tests/unit/provider-schema-verification.test.ts tests/unit/providers.test.ts tests/unit/provider-application.test.ts tests/unit/provider-ownership-inventory.test.ts` passed 74 tests in 6 files. `corepack pnpm exec tsc --noEmit -p packages/application/tsconfig.json` passed. No PostgreSQL, browser, or live-provider calls were run.
