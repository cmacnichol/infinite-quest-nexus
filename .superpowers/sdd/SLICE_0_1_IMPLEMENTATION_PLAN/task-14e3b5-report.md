# Task 14e3b5 Implementation Report

## Scope

Task 14e3b5 adds the private storage composition root and its executable ownership inventory. The composition is intentionally additive and unconsumed: no route, worker, runtime startup path, upload allowlist, or legacy service binding changed in this task. Task 14e3c remains responsible for adopting the composition at the approved runtime boundary.

Implementation base: `5cee092`.

## Delivered composition

`services/runtime/src/asset-import-composition.ts` now exports `createAssetImportStorageComposition(pool, { archiveRoot, assetRoot })`. A construction creates exactly one instance of each approved concrete dependency:

- PostgreSQL durable-filesystem repository
- PostgreSQL secure-storage repository
- PostgreSQL import repository
- PostgreSQL finalized-asset-delivery repository
- secure filesystem adapter

The composition passes the validated durable journal and all mandatory private persistence ports to the adapter. Its transaction runner delegates to the real database `withTransaction` helper, so adapter work uses one caller-owned PostgreSQL transaction instead of a test shim or nested repository transaction.

The returned object is frozen and exposes only the private graph needed by the following adoption task: `adapter`, `journal`, `candidate`, `atomicPortable`, `portable`, `prewrite`, `expiryRecovery`, `finalizedDelivery`, and an idempotent `close`. Shared secure-storage responsibilities refer to the same repository instance. Construction failure and repeated close behavior are covered by tests.

## Enforced ownership boundary

The repository boundary checker now parses the production JavaScript and TypeScript inventory and proves that:

- every named concrete factory has exactly one definition in its approved defining module;
- every concrete factory is imported directly, under its canonical name, exactly once by the composition root;
- every concrete factory is called exactly once and only by the composition root;
- the composition factory has exactly one definition and no production consumer before Task 14e3c;
- the repository-wide inventory itself, independently of the per-file boundary checker, recognizes named imports, aliases, namespace/default imports, named re-exports, export-all declarations, export-namespace declarations, CommonJS `require`, dynamic `import`, destructuring aliases, propagated aliases, and wrapped static/computed calls;
- concrete factories and the composition cannot escape through any of those forms;
- the repository wrapper and inventory share one production-source predicate covering `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, and `.tsx`; HTML and test sources never enter the storage AST inventory;
- private application contracts cannot be consumed through the application public barrels; and
- non-JavaScript/TypeScript files are excluded from the AST inventory.

The obsolete durable-filesystem repository re-export was removed from `packages/database/src/index.ts`. Repository search found no consumer of that barrel export; approved callers already import the defining module directly.

## Test coverage

The new unit suite exercises the ownership checker, including evasive syntax variants and an HTML-source regression. The new real PostgreSQL/temporary-filesystem integration suite uses only `createAssetImportStorageComposition` and covers:

- exact frozen graph shape, shared repository identity, idempotent close, closed-state rejection, and partial-construction descriptor cleanup;
- real staging, journal progression, candidate attachment, finalization, hash-only persistence, restart rehydration, owner isolation, transaction rollback, retry, replay, and fencing;
- exact export scope/content type plus EOF, close, abort, and duplicate-terminal cleanup;
- an injected throwing pre-send callback and an actual descriptor-level read failure, with the acknowledgement row locked so the test observes one descriptor before failure, zero exact or Linux `(deleted)` descriptors after unlink, committed `cleanup_pending` rows while acknowledgement is blocked, an unsettled terminal promise, and `cleaned` rows only after lock release;
- autonomous timeout and fail-closed growth, truncation, and hash faults;
- durable delivery grants, wrong-owner denial, replay denial, restart redemption, legacy delivery, and foreign-owner isolation; the shared-hash/path case holds two streams from different retained references, autonomously times one out, and proves the other still reads the exact retained bytes;
- expired portable recovery, prewrite substitution/race retry, root anchoring, and symlink denial.

## TDD and correction history

The boundary suite first failed because the composition and inventory did not exist, then passed after implementation. Review subsequently identified missing hostile syntax coverage and missing integration proof for shared hashes and actual failure ordering (projectmem issue `#0548`). Those cases were added and exercised red before the checker and integration suite were corrected.

Independent review of commit `b4de7cb` then found that the per-file checker recognized hostile forms but the repository-wide inventory still counted only identifier imports/calls, the file-descriptor assertion ignored Linux's `(deleted)` suffix, the pre-send case only supplied a terminal reason, and the shared-path case only performed two successful reads. Inventory-only namespace fixtures reproduced both ownership escapes (2 failures of 7 tests). The corrected inventory now performs its own binding/exposure/call analysis across every required syntax form. The composed failure test now drives a throwing pre-send callback and a descriptor-level read failure while a PostgreSQL row lock deterministically separates deletion from acknowledgement. The shared reference test now exercises an autonomous timeout terminal before reading the retained bytes from the second owner reference.

Fresh review of amended commit `86aa839` found one final scanner-coverage mismatch (projectmem issue `#0549`): the repository wrapper supplied only `.cjs`, `.html`, `.js`, `.mjs`, and `.ts`, even though the B5 parser supports JSX, MTS, and TSX, and the per-file guard did not reject default imports. The new wrapper/default-import fixtures reproduced both gaps (2 failures of 8 tests). The wrapper now uses the same exported production-source predicate as the inventory while retaining HTML only for unrelated repository checks. Both the per-file guard and independent inventory reject default imports of concrete factories and the unconsumed composition.

The first repository-wide inventory run also attempted to parse `index.html` as JavaScript (projectmem issue `#0547`). An HTML regression was added, the inventory was restricted to JavaScript/TypeScript source extensions, and both the focused boundary suite and full repository check then passed.

## Verification

Fresh verification after the final corrections:

- `pnpm check`: passed.
- `pnpm check:repository`: passed; 734 candidate files checked.
- Focused Task 14e1r2 through 14e3b5 unit regression: 5 files, 62 tests passed.
- Task 14e3b5 inventory correction suite: 8 tests passed after the latest expected 2-test RED; combined B5 boundary suites pass 11 tests.
- Task 14e3b5 integration suite: 7 tests passed.
- `pnpm test:unit`: 125 files, 1,433 tests passed.
- `pnpm test:integration`: 43 files, 472 tests passed.
- `pnpm build`: passed, including contracts, application, client packages, TypeScript build, legacy web build, and next web build.
- `git diff --check`: passed.

The historical Task 14e3b4 unit path emitted Node file-handle garbage-collection warnings during a focused regression run, but all affected tests passed and the new Task 14e3b5 suite did not reproduce the warning.

## Remaining work and risks

The composition is deliberately not used by production startup code yet. Task 14e3c must replace the approved runtime construction sites without introducing a second graph, preserve the same ownership and transaction boundaries, and add runtime adoption tests. No UI work is part of this task.

The private factory inventory is a static AST policy rather than a runtime dependency-injection framework. New syntax or new concrete factories must be added to the inventory and its hostile-syntax tests before they can become approved construction paths.
