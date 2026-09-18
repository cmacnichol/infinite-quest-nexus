# Turn validation success: verification matrix

Scope: requested implementation phases 01–04. Status entries remain pending until coordinator inspection establishes evidence at the final integrated SHA. No deployment or live-model improvement is implied.

## Baseline

- Base source: `2ce5508872ba0588c0c0ea51769bb828194b3f46`.
- Isolated worktree: `C:/Git/InfiniteQuest/.worktrees/turn-validation-success`.
- Five focused unit files: 75 passed.
- Real isolated PostgreSQL baseline `generation-review.integration.test.ts`: 8 passed.
- Initial integration setup failed due to a newly generated worktree test password differing from the pre-existing test volume. Reusing the existing ignored test environment corrected setup; no production database changes were made.
- Browser validation will use repository Playwright because the Browser plugin/skill is not available in this session. Native CUA is not needed for deterministic repository browser fixtures.
- Read-only production cohort reconfirmed during implementation: newest 50 jobs with `created_at <= 2026-09-18T05:05:13.987485Z`, 40 completed, 49 saved first responses, 15 valid and 34 invalid. This fixed cutoff prevents newer user jobs from changing the before/after denominator.
- Additional read-only shape audit: 145 rejected ID-bearing fact items include 63 UUID-shaped IDs, 66 short ASCII labels, nine empty strings, and seven null IDs. Phase-03 eligibility was corrected to cover these inert-label shapes only under explicit consent; actual replacement references remain exact visible UUIDs. Raw fiction was not emitted or saved in the repository.
- Remaining malformed fact wrappers: 31 contain empty `supersedes_fact_ids` arrays (zero nonempty or malformed lists), and three contain finite nonnegative integer `estimatedTokens`. These are item-shape observations, not proof that their containing stories pass every repair/authority gate.

- Coordinator phase01 rerun: six focused unit files121/121; two real PostgreSQL files69/69, no skips.
- Historical evidence availability, same fixed50 cutoff:10 jobs retain primaryResult requestBody/hash;38 retain sourceEvidenceManifest. Four invalid and four valid earliest responses exactly match retained primaryResult response bytes. The other two retained primary results belong to different observations. Do not reconstruct missing historical request content from current state; report evidence unavailable separately.

## Phase acceptance evidence

| Requirement | Required evidence | Status |
|---|---|---|
| 01 earliest primary denominator and duplicates | Reducer tests including completed-after-repair and no-response cases | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 report read-only bounded SQL and redaction | CLI tests and safe report sample | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 actual vs configured model/prompt cohorts | Cohort output fixtures and source trace | Passed at efdf6225; actual enrolled, legacy Story Direction, and v16 marked identities covered; review approved |
| 01 failure cause survives disposition | PostgreSQL failure/cancel/discard tests | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 01 public finite diagnostics | HTTP/SSE projection and injection tests | Passed at 9f5986ca; see phase-01 handoff and coordinator rerun |
| 02 mandatory rule in actual composed requests | Default/override/Action/Story Direction payload tests | Passed at 1f4e9fb9; phase-02 handoff, coordinator Linux and exact Retry regression, review clean |
| 02 old prompt identity preserved | Old job retry/resume and new enqueue integration evidence | Passed at 1f4e9fb9; phase-02 handoff, coordinator Linux and exact Retry regression, review clean |
| 03 complete decision table | Each shape accepted or rejected as specified | Pending |
| 03 content mass balance and protected fields | Exact preservation and collision tests | Pending |
| 03 parser acceptance unchanged | Direct malformed object still rejected | Pending |
| 03 ID/supersession and mechanics safety | Visible/unseen ID and mechanics fixtures | Pending |
| 04 v1/v2 wire and checkpoint compatibility | Old receipts, future versions, clients, compile checks | Pending |
| 04 explicit decision, atomic concurrency | DB duplicate/stale/wrong owner/revision/plan tests | Pending |
| 04 exact original request/source evidence | Tampering and changed authority tests | Pending |
| 04 no repeated primary generation | Composed provider-call counts before/after repair | Pending |
| 04 ordinary downstream validation retained | Strict parser, choice, continuity-off/observe/enforce and commit tests | Pending |
| 04 crash/reclaim boundaries | Before/after receipt/checkpoint/review/commit tests | Pending |
| 04 no rejected authoritative writes | Turn/state/fact/accepted Chronicle row comparisons | Pending |
| 04 Action and Story Direction, append/replacement | Composed mode/operation matrix | Pending |
| 04 optional illustrations independent | Acceptance despite illustration failure, no duplicate enqueue | Pending |
| 04 both UI surfaces | Desktop/mobile Playwright interactions and screenshots | Pending |
| 04 unreachable dispatch removed safely | Route call-count and historical resume regressions | Pending |
| Combined source quality | Fresh Terra spec/code review plus coordinator findings adjudication | Pending |
| Combined verification | Focused/full relevant units, real DB, type/check/build, diff | Pending |
| Reduces observed format failures | Bounded read-only saved-response replay and synthetic acceptance comparison | Pending |

## Outcome interpretation

Report first-pass parse success separately from deterministic repair eligibility, strict validity after repair, and actual acceptance in composed tests. Retrospective parser replay cannot prove historical downstream acceptance. User-authorized recovery is not first-pass generation improvement. Live-provider quality remains unmeasured unless separately authorized.
