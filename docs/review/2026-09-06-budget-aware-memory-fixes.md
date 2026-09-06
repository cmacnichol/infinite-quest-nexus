# Budget-aware memory retention fixes

Scope: the two gaps confirmed by the final memory/context review and two additional gaps reproduced during end-to-end verification. User requirement: larger campaign context windows should supply more history and facts to generation, within the effective provider limit. Preserve accepted ledger/state and prior uncommitted work in the existing remediation worktree. No live-data repair, deployment, publication, or main integration.

## Tasks

1. Terra retrieval: propagate effective available campaign context budget into generation retrieval. Scale candidate collection and parent selection with budget, including historical facts and fallback pools; preserve hybrid relevance, diversity, owner/campaign/world/base-turn isolation and whole records. Public previews retain their calibrated policy. The final shared serializer planner still decides which complete records fit, reserves output/safety and rejects oversized protected authority explicitly.
2. Terra facts: retain the deduplicated union of distinct canonical_facts additions and canonical_fact_updates. Preserve structured supersession links when prose duplicates and stable ordering for existing single-source output. Do not silently mutate old accepted turns or initiate live replay.
3. Follow-up ranking and authorization: rank valid historical facts alongside narrative candidates instead of appending every fact below the fused narrative pool. Include selected Chronicle fact IDs in the exact producing-request supersession allowlist while excluding unselected records and rejected drafts.
4. Verification: test-first regressions for mixed fact projection and larger-budget retrieval; real PostgreSQL/deterministic provider evidence for more full historical records AND facts in larger-budget prompts, accepted state continuity, supersession and isolation; independent spec/quality reviews; relevant combined tests/type/build/diff checks.

## Coordination and preflight

| Tasks | Shared surface | Decision |
| --- | --- | --- |
| 1 / 2 | Canonical facts flow from projection into retrieval | Distinct edit ownership. Mixed-fact regression checks persistence; larger-budget regression checks retrieval and actual serialized request. |
| 1 | Budget propagation versus final provider ceiling | Budget expands candidate eligibility; never expands provider window or lowers output reserve/safety. |
| 2 | Deduplication versus supersession | Distinct additions survive; duplicate prose cannot erase structured links. Historic single-source ordering stays stable. |
| 4 | Shared database fixture environment | Parent coordinates real PostgreSQL suite execution using isolated per-file databases. |

Status: implemented and verified in the remediation worktree. Independent review has no remaining actionable findings. Changes remain uncommitted.

## Implementation

Generation now forwards its available campaign context allowance through the
private retrieval scope. Candidate pools, per-signal ranks, parent selection,
per-turn diversity, historical facts, and the SQL sampling gates grow in 32k
steps. The supported campaign maximum bounds the growth; the calibrated public
preview profile is unchanged. Selected history retains complete parent content.
The existing final planner still enforces both campaign context and the effective
provider request ceiling, including output reserve and estimated input safety.

| Available retrieval budget | Parent allowance | Historical fact pool |
| --- | ---: | ---: |
| 32,000 | 16 | 256 |
| 128,000 | 64 | 1,024 |
| 1,000,000 | 512 | 8,192 |

These are candidate allowances, not guaranteed payload counts. The actual corpus,
relevance, record sizes, protected authority, and final request budget determine
which complete records are sent.

Canonical fact projection now combines distinct plain additions with structured
updates. Structured entries retain their prior order and identity; distinct plain
additions follow. Normalized duplicates produce one fact with all structured
supersession references retained. A real PostgreSQL test verifies both facts are
active before and after explicit replay, including the grouped Chronicle parent.
No live campaign rebuild or data repair was performed.

Larger candidate pools also use incremental maximum-similarity caching in the
diversity selector. Existing ordering tests remain unchanged. A deterministic
vector-access regression failed on the previous repeated-comparison algorithm
and passes with the bounded calculation. A single comparable local probe with
512 candidates, 256 selections and 16-dimensional vectors measured 455 ms before
and 105 ms after, with identical selected parent IDs. This is an orientation
measurement, not a timing guarantee.

## Verification record

- Full unit suite: 239 files / 2,829 passed; 44 existing Windows platform-gated filesystem/POSIX cases skipped.
- Final combined real PostgreSQL run: 8 files / 123 passed, including both actual provider-request growth paths.
- Repository boundary/data-safety and TypeScript checks passed after the final code and fixture changes.
- Build passed with the existing Vite bundle-size warning. Git configuration and line-ending warnings did not fail checks.
- `git diff --check` passed. Independent production and final test reviews have no remaining actionable findings.
- Browser and live-provider checks were not run; backend behavior was verified with real PostgreSQL and a deterministic local HTTP provider. No deployment, main-checkout integration, or live campaign rebuild was performed.

### Actual provider-request growth

The same synthetic accepted corpus is used at each budget: 120 additional full
turns, three distinct facts per turn, and a current continuity summary. Tests
build derived records through Chronicle, explicitly configure embeddings, and
check the persisted retrieval audit. The ready path drains normal index jobs;
the fallback path leaves the index unavailable. Every selected history/fact
record must equal its scoped source content, current turn facts remain present,
and foreign campaign sentinels must be absent.

Observed focused-run measurements (counts can vary with tied ranks):

| Campaign budget | Ready history / distinct retrieved facts | Ready context / request characters | Fallback history / distinct retrieved facts | Fallback context / request characters |
| --- | ---: | ---: | ---: | ---: |
| 32,000 | 2 / 13 | 13,741 / 20,087 | 8 / 12 | 31,801 / 38,269 |
| 128,000 | 18 / 45 | 71,722 / 79,156 | 30 / 114 | 127,881 / 137,121 |
| 1,000,000 | 121 / 360 | 469,458 / 486,294 | 121 / 360 | 469,458 / 486,294 |

Ready audits report `chunked_hybrid`. Fallback audits report `legacy_hybrid`
with `chunk_index_not_ready`. Both tests also passed in the final combined run.
The growth requirement is strict for both historical turns and distinct
retrieved fact IDs. Counts describe optional retrieved records; protected
current facts are checked separately. Larger windows expand eligibility rather
than requiring arbitrary filler or guaranteeing every indexed record is sent.

Each actual context stays within the campaign allowance. Each raw HTTP request
satisfies the production conservative estimate:

```text
body.length + ceil(body.length * 0.2) + 1024 <= 1,048,576 - 4,096
```

These are character-based safety estimates, not measured model token counts.
Complete records are selected or omitted; the test does not accept sliced tails.

### Additional gaps resolved during verification

- Cutoff facts previously received a rank below every fused narrative candidate. They now participate in scoped lexical/entity/recency/importance/kind/temporal rank fusion, and their scores reach final selection. Only actual chunk UUIDs enter vector queries.
- The producing-request supersession allowlist omitted selected Chronicle facts. It now includes their typed IDs alongside current continuity facts. Regression coverage verifies that an oversized canonical candidate actually omitted by the planner remains unauthorized; prose and rejected drafts do not grant authority.
- The legacy semantic shortlist also had a fixed 96-row limit. Its generation limit now scales with the same budget policy; public preview behavior is unchanged.
- A continuity fixture embedded random UUIDs in narration; dice-like fragments could trigger the mechanics filter. A stable fiction-safe password removes that flake without changing mechanics rules.

The acceptance fixture was corrected to include a nonempty authoritative
continuity summary and explicit initial embedding settings. An empty summary
correctly made the index unavailable; inherited embedding settings could make
the intended fallback fixture ready. Final tests assert the actual path rather
than inferring readiness from job completion. No production readiness check was
weakened.

### Reproduction commands

```powershell
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts tests/integration/generation-execution-repository.integration.test.ts tests/integration/chronicle-query-cache.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts tests/integration/mixed-canonical-facts.integration.test.ts tests/integration/generation-budget-growth.integration.test.ts
pnpm.cmd check
pnpm.cmd build
git diff --check
```

The PostgreSQL command must use the integration configuration and a disposable
`TEST_DATABASE_URL`; a direct skipped run is not verification. Existing mixed
outputs need an explicit rebuild from retained accepted snapshots to refresh
derived facts; this implementation does not automatically repair live data.
