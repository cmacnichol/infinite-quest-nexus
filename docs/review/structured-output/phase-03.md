# Structured output phase 03 handoff

Base: `ac63ac62b443a37be4df85fcc2546dd59c9e560e`.

This patch adds a contracts-leaf `PreparedResponseContract`, finite response-format diagnostic vocabulary, a serializer-facing contract bridge, and an optional trusted `responseContract` on text provider requests. The canonical OpenAI-compatible serializer emits strict `json_schema` payloads, preserving the schema name/body and, for OpenRouter only, `provider.require_parameters` plus the exact verified routing slugs. Native LM Studio rejects contracts before model loading or dispatch. The absent-contract branches retain the historical payload shape and format fallback behavior; contract branches reject stream mismatches, legacy-format-option conflicts, duplicate placement, and missing OpenRouter routes before dispatch. Any contract disables the existing regex fallback, so an HTTP format rejection remains one request.

RED: `tests/unit/provider-request-budget.test.ts` failed before implementation because a strict contract serialized as `{ "type": "json_object" }` rather than `json_schema`.

GREEN: the same focused suite passed 26 tests. The Patch 03 named suite (`providers`, `provider-request-budget`, `provider-response-format`, and `provider-transport-security`) passed 104 tests. `corepack pnpm check` and `git diff --check` passed.

No PostgreSQL, browser, live-provider, deployment, production-data, main-branch, push, or schema probe ran. Patch 04 remains responsible for durable selection, preflight, attempt persistence, and execution-time invocation closure. The added nullable observed result fields capture actual model/route only when supplied by the provider and never replace the legacy requested-model fallback field.
