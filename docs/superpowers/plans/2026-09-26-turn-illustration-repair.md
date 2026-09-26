# Turn illustration repair

Goal: make completed illustration assets readable and attach streaming assets reliably without regenerating existing images.
Architecture: preserve the strict accepted-turn client contract, normalize database timestamps in the API adapter, and separate provisional lifecycle from child completion. Recovery is an explicit dry-run/apply operation with owner, campaign, accepted-parent, active-set and source-text checks; it does not dispatch providers.
Stack: TypeScript, PostgreSQL, Vitest, existing Story clients.

## 1. API projection
- Add real-PostgreSQL regression coverage for completed asset timestamps and active provisional sets alongside accepted segments.
- Assert the returned payload passes illustrationSegmentsResponseSchema and contains only accepted active sets.
- Normalize string timestamps to UTC and exclude unattached/orphaned/superseded sets from the accepted projection.

## 2. Promotion and recovery
- Reproduce image completion before promotion; assert set, segment and image-job turn bindings, idempotence and retained asset identity.
- Promote eligible active unattached sets regardless of child completion status, with campaign and turn guards; preserve completed/partial status.
- Add explicit safe historical recovery with dry-run default, no provider calls, no new image jobs, no overwriting an active accepted set, and exact accepted source-segment validation.
- Cover rejected, superseded, mismatched, foreign-scope and repeated recovery cases.

## 3. Client recovery
- Test contract failures separately from transport failures, retained images after polling failures, and explicit refresh that makes no generation request.
- Add a refresh action on both Story surfaces and bounded retry of transient legacy polling errors.

## 4. Verification
- Run focused tests RED then GREEN, affected PostgreSQL integration suites, unit suite, type/build checks and diff checks.
- Verify both rendered Story surfaces using synthetic fixtures and save screenshots.
- Review the final diff independently and document recovery operation and verification limits.

Review focus: database JSON timestamp format; null turn IDs; image completion before story acceptance; safe recovery without replacement or provider dispatch; schema errors must not be presented as provider outages.

Implementation and verification complete. See [verification report](../../review/turn-illustration-repair-2026-09-26.md). Historical production recovery remains an explicit operator action.
