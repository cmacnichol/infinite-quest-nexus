# Task 14c3 Completion Report

Date: 2026-08-05

## Scope

Task 14c3 atomically composed the PostgreSQL-backed
`WorldCampaignApplication` for the API role and cut the frozen world,
campaign, session/profile, dashboard, generation-progress, state, transfer,
and Infinite Worlds transports over to that application boundary. This task
does not remove the retained legacy implementations; Task 14c4 owns removal
and the final zero-reachability audit.

The B4 bounded `/turns` reader remains intentionally unchanged. Provider- and
prompt-backed world generation and character organization remain behind the
named Task 14d collaborator factories.

## Review correction input

The first post-implementation review identified two Important findings:

1. The owner-bound `PortableWorldApplicationPort` supported preview/import but
   not export, leaving Task 14e without one named authority-safe portable-world
   import/export seam.
2. The initial Fastify route matrix injected application stubs for several
   frozen inventory families, so it did not prove the production-composed
   PostgreSQL application path or exclude a transport fallback to legacy
   business SQL.

The second review found that the production-composed matrix still accepted raw
500/502 provider failures for the five temporary Task 14d routes. Those
expectations depended on whatever text-provider profile happened to be present
instead of proving the established safe unavailable response.

No legacy removal was authorized by this correction.

## Corrections implemented

### Owner-bound portable export

- Added `PortableWorldApplicationPort.exportWorld` with an authority-free
  `{ worldId, worldVersionId? }` selector.
- The API adapter resolves the server-owned `OwnerScope` and constructs either
  a `WorldScope` or exact `WorldVersionScope` before calling
  `WorldCampaignApplication.exportWorld`.
- The Fastify world-export route now calls this named portable-world port. It
  continues to validate route/query UUIDs and preserve the existing download
  response contract.
- The seam remains explicitly named for Task 14e import/export transports;
  callers cannot supply or spoof an owner identifier.

TDD evidence: the new adapter regression first failed with
`TypeError: portableWorld.exportWorld is not a function`, then passed 1/1 after
the minimal port/adapter implementation.

### Production-composed route parity

Replaced the stub-based route matrix with eight sequential real-Fastify,
real-PostgreSQL tests. Every test injects the production
`createApiWorldCampaignApplication(pool, ...)` composition. The matrix makes
46 HTTP requests across:

1. dashboard;
2. all session/profile aliases;
3. world lifecycle, temporary Task 14d generation bindings, progress, whole
   world export, exact-version export, and deletion;
4. campaign lifecycle, published-character lookup, and world-version migration;
5. character profile and campaign transfer;
6. campaign state, sync status, and player configuration;
7. rewind validation/current-turn behavior and branching; and
8. Infinite Worlds preview/import through the owner-bound portable port.

Authority coverage sends spoofed identity headers and proves the server still
uses the initial owner. A separately created foreign owner/world/version cannot
be exported even when the request supplies that foreign UUID in the spoofed
header; the route returns the owner-scoped `world_version_not_found` response.
This also detects an ownerless or direct legacy export fallback.

The temporary Task 14d routes now run inside a controlled unavailable-provider
fixture. It snapshots existing initial-owner text-profile selection flags,
adds a deliberate enabled/default unreachable contaminant, disables every text
profile during the HTTP calls, verifies that no enabled text selection remains,
then removes the contaminant and restores the snapshot in `finally`. This
proves the test cannot drift into the raw provider transport merely because a
profile exists. All five routes require the exact safe 409 public envelope,
including the expected message, correlation ID, and either
`default_text_provider_unavailable` or `text_provider_unavailable` code.
Production route behavior was not changed; Task 14d still owns provider and
prompt replacement.

## Inventory disposition

- Route-facing world, campaign, state, character profile, transfer, dashboard,
  session/profile, and generation-progress operations use the injected
  `WorldCampaignApplication`.
- Infinite Worlds preview/import and world JSON export use the owner-bound
  `PortableWorldApplicationPort`.
- `listWorldVersionPlayableCharacters` remains an additive application method;
  the current HTTP route consumes the established playable-character summary.
- `promoteCampaignDiscoveries` remains additive with no frozen Task 14c3 HTTP
  caller.
- B4 `/turns` retains `readTurnPage` plus owner-scoped cost enrichment.
- `createTask14dCharacterProfileOrganizer`,
  `createTask14dWorldGenerationCollaborator`, and the CYOA
  `generateTemplateWorld` binding remain explicit Task 14d seams.
- No legacy source was deleted; Task 14c4 owns deletion/reduction and the final
  callable/import/export disposition audit.

## Verification

Correction-focused evidence:

- owner-bound portable export adapter: 1/1 unit test passed;
- production Fastify/PostgreSQL route matrix: 8/8 tests passed;
- route matrix request count: 46;
- whole-world, exact-version, spoofed-header, and foreign-owner export cases
  passed; and
- provider-fixture TDD first reproduced raw 502/500 responses from the
  contaminant profile, then two consecutive focused real-PostgreSQL runs passed
  8/8 with exact safe 409 assertions for all five temporary provider routes.

Final verification evidence:

- `pnpm check`: passed, including repository-boundary and data-safety checks
  across 652 candidate files;
- full unit suite: 108/108 files and 1,239/1,239 tests passed;
- full integration suite: 31/31 files and 337/337 tests passed;
- production build: passed for TypeScript, legacy Vite, and next-app Vite
  targets;
- `git diff --check`: passed;
- static audit found no forbidden direct server/import/runtime/worker caller of
  the retained world, campaign-state, campaign-transfer, dashboard, user,
  generation, or world-generation-progress legacy services;
- static audit found only the explicitly retained Task 14d character-profile,
  world-generator, and CYOA `generateTemplateWorld` seams; and
- B4 `/turns` still calls the bounded `readTurnPage` reader.

## Next step

After this correction is independently reviewed and committed, Task 14c4 may
remove/reduce retained legacy callables and run the frozen zero-reachability and
parity audit. Task 14d remains responsible for provider, prompt, intent, cost,
world-generation, and character-organizer temporary bindings.
