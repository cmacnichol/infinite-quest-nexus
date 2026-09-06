# Targeted remediation fixes

Baseline: `c14978e`. Scope: the seven findings in the completed-work review.
The binding requirements remain the September 5 remediation specification.

## Work assignments and acceptance

1. Output budget (Terra): measure the complete preserved extension story and replacement continuity; reject impossible reserves and narration lengths before transport. Prove RED/GREEN with long narration and continuity.
2. Runtime integrity (Terra): include fiction-safe protected authority and original action in extension requests; remove mechanical state from fiction requests; validate final checkpoint provenance and final-request fact visibility; cover before/pending/immediate event fiction, including appended passage, with bounded repair and recoverable failure. Test resume and no-commit failures.
3. Retrieval (Terra): give generation the full ranked candidate records before final budget selection, without the fixed 32K public-preview limit. Preserve owner/campaign/version isolation and public preview behavior; test large candidate sets and uncompressed content.
4. Proxy configuration (controller): honor the configured trusted hop count; test direct/untrusted forwarding and controlled positive hop counts.
5. Combined verification: review each task's actual diff and RED/GREEN evidence, run relevant combined suites and type checks, and review the whole targeted diff. Report PostgreSQL/browser/provider checks accurately.

## Execution rules

Use the existing isolated remediation worktree. Keep production edits scoped and preserve unrelated changes. Agents own disjoint files, coordinate runtime interface changes, and do not commit or publish. Complete regressions before production fixes. No deployment or main-checkout integration is part of this work.

## Completed fixes

| Review finding | Result |
| --- | --- |
| Extension output feasibility | Complete preserved narration and continuity are measured with the parser-valid minimum suffix. Initial extension and repair requests enforce token and character limits before transport. |
| Extension authority | Main and repair inputs retain protected fiction authority, original action, and the complete validated main draft independently of optional rejected output. |
| Producing-request provenance | Version 2 checkpoints retain exact request bytes/hash, effective configuration and endpoint identity, original input/draft identity, and the actual producing request's fact allowlist. Reclaim rejects malformed or mismatched provenance. |
| Event coverage | Every occurrence requires its own coverage result; immediate events require full-story and appended-passage coverage. Repair is bounded, preserves validated main narration, and may replace a rejected suffix. Pending occurrences count on fulfillment, with duplicates counted once. |
| Large-window retrieval | Generation and previews share hybrid ranking and audit execution before preview compression. Whole selected records reach the planner; bounded retrieval retains recent turns beyond 512 records and excludes the already protected latest turn. |
| Mechanics separation | Narrative authority omits private RPG/trigger state and mechanical tracker values while retaining diegetic tracker facts. |
| Trusted proxy | Zero trusted hops disables forwarding; positive configured hop counts are honored. |

Review also corrected oversized rejected-draft recovery: omit the complete draft,
retain protected input, request clean regeneration, and remeasure the actual
fallback payload. Protected input that still cannot fit fails before transport.

Terra implementers completed independent areas, followed by task reviews and a
whole-diff review. All reported blocking review findings were resolved; the final
review approved the repaired-extension producing-request allowlist on September 6.

## Final verification

- **Passed:** full unit suite, 237 files / 2,808 tests. **Skipped:** 44 existing platform-gated filesystem/POSIX cases on Windows.
- **Passed:** 111 real PostgreSQL tests across generation, generation-execution repository, Chronicle chunk retrieval, Chronicle contract matrix, and composed continuity suites. Tests used the isolated database and deterministic provider fixtures.
- **Passed:** `pnpm check`, `pnpm build`, and `git diff --check`. Build retains the existing web bundle size warning.
- **Not run:** live-provider verification; deterministic HTTP provider fixtures were used. Rendered browser testing was not repeated because these fixes change backend behavior without visible UI edits.

Commands:

```powershell
node node_modules/vitest/vitest.mjs run tests/unit --exclude '**/.worktrees/**' --exclude '**/.codex/**'
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/generation.integration.test.ts tests/integration/generation-execution-repository.integration.test.ts tests/integration/chronicle-chunk-retrieval.integration.test.ts tests/integration/chronicle-contract-matrix.integration.test.ts tests/integration/story-continuity-remediation.integration.test.ts
pnpm check
pnpm build
git diff --check
```

The changes remain in the isolated worktree and have not been committed,
published, deployed, or integrated into the main checkout. Older private draft
checkpoints require discard/re-enqueue rather than adoption; see
[Story context integrity](../architecture/story-context-integrity.md).

## Subsequent review

The next completion review found four additional issues after the results above:
main repair exhaustion, whole-main rewrite budgeting, authority locks across
embedding calls, and effective per-operation context/safety limits. The follow-up
work and fresh evidence are recorded in
[Second-review targeted fixes](2026-09-06-second-review-targeted-fixes.md).
