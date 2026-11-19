# OpenRouter preset routing format compatibility

Clearing provider Order in OpenRouter can return `order: null` alongside
`sort: { by: "price", partition: null }`. Nexus previously treated null Order
as active, rejected Order with Sort, and accepted only string sorting. This
caused submission to fail with HTTP 422 before a generation job existed.

Preset discovery now removes documented nullable routing defaults before
validating against the shared routing contract. Null values are not removed
from unknown fields or from non-nullable price limits. False, zero, empty
arrays and explicit restrictions remain intact. The original input is not
mutated; the normalized routing configuration is deeply frozen and hashed.

Supported routing formats include:

- String or object sorting, including `by` and `partition: "model" | "none"`.
  The current API also lists `exacto` as a sorting strategy.
- Order and Sort together, preserved for OpenRouter to apply its documented
  precedence: sorting is used when Order is not specified.
- Numeric or percentile performance preferences (`p50`, `p75`, `p90`, `p99`).
- Numeric or non-negative decimal-string price limits, including `audio`.
  Strings are preserved to avoid rounding precision-sensitive price limits.

The same normalized shapes pass public preset detail projection, route/plan
validation, durable JSON reload and concrete-route request serialization.
Story still dispatches one `@preset/<slug>` candidate and lets OpenRouter
apply the remote routing policy. No local fallback behavior changes.

This is compatibility for supported routing settings, not unrestricted preset
passthrough. Unknown fields, provider-specific `options`, tools, stop sequences
and transforms remain rejected. Existing bounds and finite-number validation
remain in force. No prompts, credentials or private campaign fixtures are added.

No database migration or prompt-protocol change is needed. Deploy compatible
API and worker binaries together. Older binaries cannot read newly frozen
advanced routing shapes; drain jobs using those shapes before rollback. Existing
plans are not rewritten, and their hashes remain stable. This work does not
diagnose the separate HTTP-200 streaming error or deploy to production.

Sources checked November 18, 2026:

- [OpenRouter routing guide](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter OpenAPI schema](https://openrouter.ai/openapi.json):
  `ProviderPreferences`, `ProviderSort`, `ProviderSortConfig`,
  `PreferredMinThroughput`, `PreferredMaxLatency`, and percentile cutoffs.

Regression coverage exercises null normalization, discovery, public projection,
invalid/unknown values, false/zero preservation, immutable plan reload and hash
tampering, and the serialized transport body. Deterministic tests do not prove
live provider availability or narrative quality.

Verification on Windows:

- Unit suite: 5,871 passed, 44 existing platform-specific skips. An initial
  sandbox run had filesystem-permission failures; the unrestricted rerun passed.
- Real PostgreSQL: 53 passed across `generation-repository` and
  `preset-generation-workflow`, using the dedicated integration configuration
  and isolated per-file databases. This covers rejection non-mutation and
  owner/campaign boundaries with deterministic providers.
- Root TypeScript check, TypeScript build compilation, repository boundary and
  data-safety checks, and `git diff --check` passed.
- Independent review: no actionable findings.
- Browser and full frontend bundling were not run; no UI code changed.
  Live generation and production deployment were not performed.
