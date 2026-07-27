# Linux Archive Integration Coverage Design

## Summary

Infinite Quest Nexus supports API execution only through Linux Docker in production. Native Windows development must retain the archive subsystem's fail-closed behavior because the current Node.js implementation cannot pin a directory with the stable handle semantics required for safe generated-archive staging.

The test strategy will distinguish platform-neutral integration behavior from successful archive staging. Native Windows will continue running unit tests, database integration tests, archive import validation, and other platform-neutral coverage. Tests that require successful generated-archive staging will run only where the shared capability predicate reports support. Ubuntu CI will run the complete PostgreSQL integration suite so every production archive success path remains mandatory.

## Goals

- Make `pnpm test` meaningful and green on native Windows without weakening archive path security.
- Preserve the existing `archive-entry-unsafe` failure when secure generated-archive staging is unavailable.
- Run every successful campaign archive export, staging, preview, cleanup, and gameplay export scenario on Linux CI.
- Keep platform-neutral campaign archive and gameplay coverage active on Windows.
- Use one production-owned capability predicate so runtime behavior and test selection cannot drift.

## Non-Goals

- Do not add native Win32 directory-handle support.
- Do not permit path-only generated-archive staging on Windows.
- Do not weaken symlink, junction, directory-identity, cleanup, or root-boundary checks.
- Do not move the entire local test runner into a Linux container.
- Do not change campaign archive formats, API contracts, database schemas, or production deployment manifests.

## Architecture

### Shared capability contract

`services/api/src/archive-io.ts` will expose a small capability predicate for secure generated-archive staging. It will report support only when the implementation can create and retain the stable directory anchor used by staging and cleanup. With the current implementation, that means Linux is supported and native Windows is unsupported.

`createArchiveStagingDirectory` will call the same predicate before attempting generated staging. Unsupported platforms will continue returning:

```text
archive-entry-unsafe: This platform cannot safely stage generated archive assets.
```

The predicate describes the implemented filesystem capability, not a general statement that Windows is unsafe. If native Windows handle support is added later, the predicate and its tests can change together.

### Platform-aware test boundaries

Tests will be classified by the capability they exercise:

1. **Platform-neutral tests** continue on all supported development hosts. These include database behavior, archive parsing and validation, imported upload staging where already supported, state transitions, and non-export gameplay behavior.
2. **Secure generated-staging tests** run only when the shared capability predicate returns true. These include campaign export artifact creation, export-to-preview round trips, generated staging cleanup, and API export responses.
3. **Fail-closed tests** run on unsupported hosts and prove that generated staging is rejected with the typed `archive-entry-unsafe` error before filesystem mutation.

The campaign archive integration file will gate the narrow suite that depends on successful `exportCampaign` staging rather than skipping the entire file. The gameplay integration scenario will separate its campaign ZIP export assertion from the broader story workflow so native Windows retains the rest of the gameplay coverage.

Skipped test output must identify secure generated-archive staging as the missing capability. Tests must not silently return early or convert unsupported-platform behavior into a passing assertion.

### Linux integration enforcement

The GitHub Actions runner already uses Ubuntu, Node.js, pnpm, and Docker. CI will add a PostgreSQL integration step using the repository's `scripts/ensure-test-database.mjs` and `vitest.integration.config.ts` path through `pnpm test:integration`.

The integration harness will provision the pinned pgvector PostgreSQL image with generated test-only credentials. The CI workflow will not embed a reusable database password or accept a browser-supplied database URL.

`tests/unit/ci-workflow.test.ts` will be updated to require:

- the database-independent unit step;
- a distinct PostgreSQL integration step;
- no hard-coded `TEST_DATABASE_URL`;
- no workflow-level PostgreSQL service credentials;
- the existing type-check, build, Compose validation, Swarm validation, and image build steps.

This restores Linux integration enforcement without reverting to the obsolete workflow-owned PostgreSQL service configuration.

## Data and Control Flow

On native Windows:

1. The test harness provisions PostgreSQL in Docker.
2. Platform-neutral integration tests execute through the host Node.js process.
3. Tests requiring generated archive staging are marked skipped by the shared capability predicate.
4. A focused unit test verifies that direct staging attempts fail closed with `archive-entry-unsafe`.

On Ubuntu CI:

1. Dependencies, type checks, and unit tests run.
2. `pnpm test:integration` provisions the dedicated PostgreSQL container.
3. The shared capability predicate enables generated archive staging tests.
4. Campaign export, preview, cleanup, and gameplay export success paths execute against a real database.
5. Build and deployment-configuration validation continue after tests pass.

## Error Handling and Security

- Unsupported staging remains an explicit typed error; it is never downgraded to a warning or path-only fallback.
- Capability checks happen before staging directory creation or archive writes.
- Linux staging continues using stable directory anchors and identity revalidation.
- Windows junction and symlink rejection tests remain active wherever their tested operation is supported.
- CI failures in any Linux archive success path fail the workflow.
- Test selection uses the production capability predicate rather than duplicating `process.platform` checks throughout the suite.

## Testing Strategy

### Unit tests

- The capability predicate reports the current platform's implemented support.
- `createArchiveStagingDirectory` rejects unsupported staging with `archive-entry-unsafe`.
- Existing Linux directory-replacement and cleanup-race regressions remain enabled on Linux.
- CI workflow tests require both unit and PostgreSQL integration steps without committed credentials.

### Integration tests

- Native Windows runs all platform-neutral integration suites.
- Native Windows records explicit skips only for secure generated-staging cases.
- Ubuntu runs the complete campaign archive export suite and gameplay export assertion.
- Campaign archive import and database behaviors not dependent on generated staging remain cross-platform.

### Completion verification

- `pnpm test:unit`
- `pnpm test:integration` on native Windows, with only named secure-staging cases skipped
- `pnpm check`
- `pnpm build`
- `git diff --check`
- GitHub Actions Ubuntu run showing the secure-staging cases executed rather than skipped

## Rollout and Compatibility

There is no production migration. Linux Docker behavior is unchanged except for using the explicit capability predicate already implied by the stable-anchor requirement. Native Windows remains unsupported for direct API archive generation and gains accurate local test reporting. Existing archive files, database rows, API clients, and deployment configuration remain compatible.

## Acceptance Criteria

- Native Windows no longer reports the 21 secure-staging cascade failures during `pnpm test`.
- Native Windows does not claim successful archive generation; affected cases are explicit capability skips.
- Direct native Windows generated staging still returns `archive-entry-unsafe`.
- Ubuntu CI runs and passes the previously failing campaign archive and gameplay export scenarios.
- No archive safety check or production contract is weakened.
- No unrelated integration test is skipped.
