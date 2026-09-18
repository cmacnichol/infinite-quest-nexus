# PATCH01 runtime wiring report

Base: `41bf13b1` on `codex/structured-output`.

## Connected paths

- `createInternals` now creates one composition-lifetime `ProviderResponseFormatCapabilities` collaborator before `bind`. Every bound runtime adapter receives that same collaborator.
- Saved text inventory discovery now uses its process-local capability inventory cache. Its key includes owner, profile, provider type, normalized endpoint hash, model, stable non-secret route-config hash, and `text-schema-adapter-v1`. Image and embedding discovery remain independent.
- Both the outer application mutation wrappers and transaction-bound application wrappers invalidate capability entries after successful profile update or deletion.
- The collaborator remains exposed on API and worker compositions for PATCH04 durable preflight. Its eligibility function retains the safe verification registry digest comparison; no distributed-worker membership is claimed or introduced.
- Cache invalidation and explicit refresh detach stale in-flight discovery promises, preserve newer loads, bound entries to 1,000, and clean evicted generation state. A current exact verification record now wins when an older exact record is expired.

## RED

Before wiring, `corepack pnpm exec vitest run tests/unit/provider-postgres-adapters.test.ts` failed the new composed adapter regression: two saved text inventory reads plus one embedding read made 3 transport calls, where 2 were expected. This showed that runtime discovery bypassed the capability cache.

Before the resolver change, `corepack pnpm exec vitest run tests/unit/provider-capability-cache.test.ts tests/unit/provider-response-format.test.ts` failed the added current-record regression: the resolver returned `advertised` when an expired exact verification preceded a current exact verification.

## GREEN

`corepack pnpm exec vitest run tests/unit/provider-capability-cache.test.ts tests/unit/provider-response-format.test.ts tests/unit/provider-postgres-adapters.test.ts`

Result: 3 files, 16 tests passed.

`git diff --check --` limited to the owned runtime/cache/resolver/test files completed with exit 0.

The root-level `corepack pnpm check` is intentionally deferred to the coordinator after the disjoint configuration-loader correction lands, avoiding a duplicate check against an in-progress shared worktree. No PostgreSQL, browser, live-provider, deployment, push, or main-checkout action occurred.
