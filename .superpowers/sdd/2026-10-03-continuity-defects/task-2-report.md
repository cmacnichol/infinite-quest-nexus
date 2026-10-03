# Task 2: Verify retrieval through final requests and accepted replay

## Result

Added a real-PostgreSQL composed regression in `tests/integration/story-continuity-remediation.integration.test.ts`. It explicitly enrolls R3 with cast context and history coverage enabled, captures the persisted v5 history diagnostic, and confirms `storyLedger` and `protectedFacts` are serialized. An older accepted fact is omitted from protected/current continuity after 80 newer long facts are accepted; a later direction retrieves it through lexical Chronicle fallback.

The regression compares the captured writer request with the persisted `primaryResult.requestBody`, checks the older fact appears exactly once at `user.authoritative_context.chronicle[0].content`, and ties that wire content to its database ID through both `primaryResult.sentFactIds` and the source evidence manifest's `canonicalFactId`. Persisted diagnostics show one selected candidate and `semantic_retrieval_unavailable` fallback. The deterministic writer then supersedes that transmitted ID; the old fact closes at the accepted turn, points to one replacement, and the next real worker request contains the replacement without the old fact. Existing turn snapshots and stored source fact text remain unchanged. The regression also asserts that the composed run captured exactly one story writer request, with no repair or retry request omitted from inspection.

No production file change was needed: the composed v5 path recalled the fact and enforced sent-ID supersession correctly. The other three brief-listed test files already provide direct coverage for the requested controls, so they were reused without duplicating fixtures.

## Requirement-to-test evidence

- Database authority → reservation → retrieval → final manifest/writer serializer and separate reviewer budget estimates: `history-coverage-context.integration.test.ts`, tests `composes the PostgreSQL ledger loader through the exact planner manifest and reviewer serializer` and `measures one captured authority through reservation, retrieval, and final serializer planning at every supported envelope`. The real-PostgreSQL measurement exercised both writer and reviewer serialization; at the 1,000,000-token writer envelope, the reviewer cap was 500,000 and measured reviewer headroom remained positive (1,203 tokens).
- Older fact recall, candidate replenishment, future validity, campaign/world isolation, and deterministic lane exhaustion: `chronicle-historical-fact-pool.integration.test.ts`, tests `recalls old exact and entity-linked facts before 300 newer distractors, preserving legacy calibration`, `replenishes the lexical historical lane after reserved fact IDs consume its initial rank pool`, `uses historical validity and excludes future facts without a derived rebuild`, and `fills exhausted lanes deterministically and keeps scopes isolated`.
- Foreign, retired/inactive, future, mismatched/source-invalid, imported, and missing-source candidates; correction frontiers including explicit empty correction; source arrays not repaired: `history-protected-facts.integration.test.ts`, tests `withholds foreign, retired, future, mismatched, imported, and missing projection candidates without repairing rows`, `withholds explicit-ID accepted and correction facts when only their source indices are tampered`, `retains reordered correction IDs from their original source while withholding a tampered new correction ID`, and `suppresses stale pre-frontier rows after an empty correction while retaining a later accepted fact without repairing projection`.
- End-to-end v5 recall, exact wire payload, sent-ID authorization, one-time accepted supersession, replay, and unchanged snapshots/source facts: new `story-continuity-remediation.integration.test.ts` test `recalls an older fact omitted from protection, accepts its transmitted supersession, and replays the replacement`.
- Unsent supersession rejection control: existing `story-continuity-remediation.integration.test.ts` parameterized test `accepts %s once, preserves raw evidence, and replays accepted authority`, case `unsupplied structured supersession`; direct repository coverage is also in `generation-execution-repository.integration.test.ts`, test `accepts a supersession only for an active same-campaign fact rendered to the provider`.
- Chunked retrieval readiness: the history-coverage measurement test above seeds ready Chronicle chunks and deterministic embedding dependencies. The new composed regression separately proves lexical fallback when semantic retrieval is unavailable.

## Verification

Each required integration file ran in its own Vitest process with `--config vitest.integration.config.ts` against the dedicated real PostgreSQL service:

| File | Result |
| --- | --- |
| `tests/integration/history-coverage-context.integration.test.ts` | 6 passed, 0 skipped |
| `tests/integration/history-protected-facts.integration.test.ts` | 10 passed, 0 skipped |
| `tests/integration/chronicle-historical-fact-pool.integration.test.ts` | 8 passed, 1 skipped |
| `tests/integration/story-continuity-remediation.integration.test.ts` | 8 passed, 0 skipped |

The one Chronicle skip is the optional 1k/10k/100k performance benchmark, guarded by `RUN_HISTORICAL_FACT_BENCHMARK === "1"`; it is not an integration correctness case. A final focused run of the new case also passed (1 passed, 7 filtered). During test development, several focused runs failed on incorrect assumptions about persisted/wire field placement; those assertions were corrected to use the real `primaryResult`, source manifest, and serialized wire path. The final complete affected files all passed as reported above.

`git diff --check` passed. No browser or live-provider checks were applicable; the composed provider fixture is deterministic.
