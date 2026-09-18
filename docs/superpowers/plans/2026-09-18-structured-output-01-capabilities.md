# Structured output 01: capability discovery implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; fresh gpt-5.6-terra implementer, then fresh Terra specification and code reviewers.

**Goal:** Preserve provider metadata and produce a trustworthy, deterministic response-format eligibility decision.

**Architecture:** Validate advertisements at the transport boundary, preserve them through inventory ports, and combine them with operator verification records. Cache metadata only; new-job policy remains explicit and old jobs remain unchanged.

**Tech Stack:** TypeScript, Zod, Vitest, existing provider transport.

**Spec:** [Index and global constraints](2026-09-18-structured-output.md). Dependency: verified main baseline.

## Files and ownership

- Create `packages/contracts/src/text-response-format.ts`, `packages/application/src/providers/response-format.ts`, `services/runtime/src/provider-capability-cache.ts`, `services/runtime/src/provider-schema-verification.ts`.
- Modify `packages/contracts/src/index.ts`, `generation.ts`; `packages/application/src/providers/types.ts`, `ports.ts`, `index.ts`, `use-cases.ts`; `packages/story-engine/src/providers.ts`; `services/runtime/src/provider-credential-transport-adapter.ts`, `provider-application-composition.ts`; `services/api/src/provider-application-adapter.ts`.
- Tests: extend `tests/unit/providers.test.ts`, `provider-application.test.ts`, `provider-ownership-inventory.test.ts`; create `tests/unit/provider-response-format.test.ts`, `provider-capability-cache.test.ts`.
- Modify the existing runtime config loader in `packages/database/src/config.ts` and wiring in `services/runtime/src/main.ts`; read `docs/installation/provider-configuration.md` and `docs/runbooks/deployment.md` first.

## Shared interfaces introduced here

```ts
type TextResponseFormatPolicy = "legacy" | "auto" | "required";
type ResponseSchemaOperation = "story" | "choices" | "continuity_review";
type SchemaVerification = Readonly<{
  version: 1; providerType: "openrouter" | "openai_compatible";
  endpointIdentity: string; model: string;
  routeConfigHash: string; adapterProtocol: "text-schema-adapter-v1";
  operation: ResponseSchemaOperation; schemaHash: string;
  streaming: boolean; verifiedAt: string; expiresAt: string;
  providerRoutingSlugs: readonly string[];
  nativeOpenTrackerObjects: boolean;
}>;
type ModelParameterAdvertisement = Readonly<{
  supportedParameters: readonly string[] | null;
  discoveredAt: string;
}>;
type ResponseFormatEligibility = Readonly<{
  status: "verified" | "advertised" | "unsupported" | "unknown";
  reason: "verified" | "missing_metadata" | "not_advertised" |
    "missing_verification" | "expired" | "schema_incompatible" |
    "unresolved_model" | "discovery_unavailable";
  verification: SchemaVerification | null;
}>;
```

`resolveResponseFormatEligibility` in the application module consumes advertisement, exact endpoint/model, operation, schema hash, streaming flag, current time and matching verification record. It returns the above eligibility without I/O. `selectResponseFormat(policy, eligibility)` returns `legacy`, `json_object`, `json_schema`, or `unavailable`. `legacy` is a distinct compatibility outcome, not an alias for new JSON-object mode. Patch 02 supplies concrete schemas; this patch tests supplied synthetic digests.

## Task 1: metadata preservation and policy validation

- [ ] RED: provide discovery responses with both parameter names, only `response_format`, absent field, explicit empty array, malformed values and unrelated keys. Assert the API inventory preserves a validated advertisement; absent/malformed becomes unknown rather than true. Test all saved/candidate projections and text-role/embedding fallback isolation.
- [ ] Run `corepack pnpm exec vitest run tests/unit/providers.test.ts tests/unit/provider-ownership-inventory.test.ts tests/unit/provider-application.test.ts`; record the missing-metadata assertion failure.
- [ ] Implement bounded parsing: at most 128 distinct parameter names, each at most 128 characters; unknown names remain safe strings, nested payloads are discarded. Do not infer support from model names or JSON mode alone. Use server discovery time.
- [ ] Add validated `textResponseFormatPolicy` to the closed safe allowlist. Missing values are interpreted as legacy at resolution but are not physically inserted into historical configuration objects, preserving old fingerprints. Invalid submitted policy is rejected; untrusted capability/probe claims are ignored.
- [ ] GREEN: repeat focused tests, check contracts/application types and review the complete diff. Confirm image/embedding inventories and credentials remain unchanged.

Example behavioral assertion (using a mocked discovery HTTP response in existing transport fixtures):

```ts
expect(inventory.models[0].responseFormatAdvertisement.supportedParameters)
  .toEqual(["response_format", "structured_outputs"]);
expect(selectResponseFormat("auto", unknownEligibility)).toBe("json_object");
expect(selectResponseFormat("required", unknownEligibility)).toBe("unavailable");
```

## Task 2: cache, verification records and resolver

- [ ] RED with fake clock: identical concurrent cache loads make one inventory call; different owner/profile/endpoint/model/config digest never share entries; exactly 24 hours expires an entry; explicit refresh replaces it; failed refresh returns unknown; endpoint/model/policy changes invalidate; restart causes a new-job miss, not a guessed positive.
- [ ] Add a process-local bounded cache (maximum 1,000 entries, least-recently-used eviction). The exact key is `[ownerUserId, providerProfileId, providerType, normalizedEndpointIdentity, model, routeConfigHash, adapterProtocol]`. `routeConfigHash` is SHA-256 of capability-relevant non-secret routing/settings using stable serialization. Never use credentials or `updated_at` as the identity. Profile update/delete invalidates matching entries; composition lifetime owns the cache. Concurrent explicit refreshes also single-flight; a refresh generation counter prevents an older in-flight discovery from overwriting a newer profile selection.
- [ ] Add a validated operator-only JSON verification file, selected by `TEXT_SCHEMA_VERIFICATION_FILE`. Missing file means no verified routes. Invalid configured file fails configuration validation with a safe error. Load through the normal runtime config composition; do not read environment variables in domain functions. Limit file to 1 MiB/1,000 records. Records expire after at most 30 days; exact schema/model/operation/streaming match required. Hash endpoint identity; never expose secrets or raw endpoint responses through API projections.
- [ ] Distribute the same immutable verification-file digest to `all`, `api` and `worker` roles using the existing configuration mechanism; reload requires process restart. Inject the parsed records and clock into API inventory status and worker preflight. API verified status is advisory until worker preflight; expose the safe configuration digest and test identical inputs produce identical coverage. Mismatched replica digests must display unknown/stale status rather than promise worker eligibility. Cache expiry affects metadata only. Match `routeConfigHash` and `adapterProtocol` exactly for cache, verification record, resolver and frozen contract; routing/normalizer changes invalidate verification.
- [ ] RED/GREEN resolver table: current exact record + advertised support => verified; stale/missing record => advertised; unsupported tracker schema => unsupported; preset/alias without concrete identity => unknown; `required` unavailable yields no execution permission. Non-OpenRouter verification requires an explicit adapter type match and must not generate OpenRouter fields.
- [ ] Record operational-cache/nonportable and operator-record semantics in handoff. No database migration is required for process cache or operator file. Durable job selections arrive in patch 04.
- [ ] Commit only patch 01 scope after focused GREEN and `git diff --check`.

## Exit gate

Discovery/API metadata and deterministic eligibility are tested, no generation behavior changed, no live calls were made, and old configuration fingerprints remain byte-compatible. Handoff documents new types, cache injection, safe config handling and command results.
