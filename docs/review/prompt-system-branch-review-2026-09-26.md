# Prompt system branch review and continuation

Reviewed `fix/prompt-system-remediation` at `7056f6ed` against merge base
`f69785f41f72b9baef6c817e6edd0d234b54ac73`. The working tree was clean on arrival.
The implicit-acknowledgement plan was recorded complete; the broader remediation
still needed independent verification and rollout evidence.

## Standards review

- **Build provenance (P2), fixed:** the default Git reader excluded untracked
  source files, so an image could report a clean commit while containing extra
  source. The reader now includes nonignored untracked files. A real temporary
  Git repository reproduced the false clean flag before the fix.
- **Preview accuracy (P2), fixed with an explicit limitation:** direct models
  can select verified v3 output, but the preview claimed they always use v2.
  Direct-model previews now identify output encoding as unresolved and explain
  that the enqueue capability check supplies that contract.

## Specification review

- **Historical queued requests (P2), fixed:** an old preset job without a
  worker-selected response closure could pick up v3 on first execution. The
  worker now passes the frozen route protocol into schema selection. Missing
  or historical preset identities retain v2; the new preset route opts into v3.
  Already-frozen closures and verified direct-model selection remain unchanged.
- **Current preview policy (P2), fixed:** previews used the latest job's cast
  protocol rather than current runtime settings. Runtime composition now passes
  the current cast setting to the preview repository. Tests cover both enabling
  and disabling cast despite the opposite historical job setting.
- **Direct-model preview (P2):** the same accuracy finding appears on this
  axis because Task 2 permits verified direct-model v3. The preview is explicitly
  partial; exact direct-model wire preview remains a limitation.
- **Related test maintenance, fixed:** eleven PostgreSQL cases still expected
  local preset instruction injection after Task 13 moved it to OpenRouter.
  They now assert the new frozen route identity, `@preset` dispatch, and absence
  of duplicated local preset instructions. Existing historical-route coverage
  remains in place.

Standards: two findings addressed. Specification: three findings addressed,
with direct-model preview parity explicitly limited. Historical queued request
identity was the highest-impact specification finding.

## Verification

Regression tests demonstrated RED then GREEN for historical schema selection,
current cast preview, direct-model preview labeling, and untracked build inputs.

- **Passed:** `corepack pnpm check`, `corepack pnpm build`, and
  `git diff --check`.
- **Unit suite:** 4,552 passed, 3 failed, 44 skipped across 358 files, with
  `.worktrees` and `.codex` excluded. The three failures match those named in
  the previous handoff: the 48,000-token reserve case in
  `prepared-text-executor.test.ts` and two source-string viewport assertions in
  `story-player-ui.test.ts`. They also failed before this continuation's edits;
  this review does not call the full suite green. The suite's skipped cases
  were not executed and are not verification evidence.
- **PostgreSQL:** all 172 targeted tests passed across five files. The initial
  run passed 41 cases in response-contract persistence, operation matrix, and
  Story Memory enrollment; 11 stale assertions failed in the other two files.
  After correcting those assertions, all 131 cases in provider failures and
  continuity review passed on rerun. The full integration suite was not run.
- **Browser:** all three Prompt Library tests passed: application save,
  campaign save, and current-policy/partial-wire preview. The final screenshot
  was captured again after scrolling the preview to the changed contract area.
- **Build test environment:** the web-build unit suite initially failed under
  sandbox child-process restrictions; all five tests passed outside the
  sandbox, including in the final full unit run.

The normal integration harness could not authenticate to its existing test
database. Verification used a disposable PostgreSQL 18/pgvector container,
bound only to a Docker-assigned localhost port, with the repository's per-file
database isolation setup. No production database or external provider was used.
The disposable container was stopped and automatically removed after testing.

Browser plugin not available; the repository's Playwright workflow was used.
The preview test calls the real preview repository with synthetic database
responses and verifies the rendered result. Screenshot:
[Prompt Library preview](assets/prompt-system-review/preview.png).

## Remaining rollout work

- No deployment, paid provider call, or campaign override consolidation was
  performed. The remediation plan requires explicit authorization for live
  provider checks and per-campaign production data changes.
- Task 8 still needs a provenance-tagged deployment and synthetic/authorized
  real-campaign provider evidence. Mock-provider tests do not establish live
  narrative quality or quote retention at production context sizes.
- Task 11 consolidation is optional after implicit acknowledgement and remains
  a per-campaign decision.
- Delivery target: existing pull request #168 on `fix/prompt-system-remediation`.
