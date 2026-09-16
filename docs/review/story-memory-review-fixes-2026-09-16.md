# Targeted Story Memory review fixes

Scope: the four confirmed findings from the post-implementation review. Preserve the existing campaign ledger, operational enrollment defaults, legacy job readers, and unrelated worktree changes.

| Fix | Change | Regression evidence required |
| --- | --- | --- |
| F1: repeated canonical fact IDs | Preserve the originating destination identity when an explicit fact ID is repeated across accepted snapshots. | A valid legacy source rebuilds; its branch and portable import retain corrections and supersession without duplicate IDs. |
| F2: character-profile response | Validate the complete GET/PUT response using a shared contract. | Real endpoint-shaped responses load/save; malformed responses remain rejected; both Story interfaces render the profile editor. |
| F3: selected world evidence | Match selected world records to their manifest using consistent immutable provenance. | Actual serialized entity/relationship evidence binds; tampered or missing references fail; enrolled review can accept a valid turn. |
| F4: prompt-library readback | Resolve displayed review/repair overrides with the same precedence and bytes as generation snapshots. | Application/campaign overrides, inherited defaults, reset, ownership and frozen snapshots agree. |

Implementation uses focused RED/GREEN regressions, independent review, related unit/PostgreSQL checks, rendered profile-editor checks, and type/build validation. Production rollout and live-provider quality gates remain separate from these fixes.

Status: all four fixes implemented and independently reviewed. No consequential review findings remain in these targeted fixes.

## Implementation and regression results

- F1 preserves the first registered destination identity for repeated explicit object fact IDs. The failing unit regression is now green. Real PostgreSQL tests cover valid source replay, branch, portable campaign import, retained corrections, fact retirement/supersession and unchanged source evidence.
- F2 defines separate strict shared response schemas for the complete profile GET view and the narrower PUT result. Regression tests use the real response fields and reject malformed payloads. Browser fixtures now reproduce those distinct endpoint responses.
- F3 records the selected wire reference ID in each world-reference evidence entry while retaining its immutable world-version revision/hash. Actual serialized entity/relationship requests now bind; missing, altered, foreign-ID and mismatched-path evidence is still rejected. Observe and enforce executor tests both accept valid reviewed turns.
- F4 shares continuity-prompt resolution between the library response and the frozen job snapshot. Both review and repair templates pass application/campaign precedence, inherited defaults, reset, ownership, exact content/hash/source and frozen-snapshot checks. Both readback regressions failed before the fix.

| Verification | Result |
| --- | --- |
| Related unit tests, eight files | Passed: 207 tests |
| Prompt library, continuity review and character-profile repository PostgreSQL suites | Passed: 49 tests |
| Branch/import fact-remapping PostgreSQL regressions | Passed: 2 tests |
| Additional independent story-context payload PostgreSQL coverage | Passed: 16; skipped: six opt-in pre-fix baseline probes |
| Profile load/save, append/replacement recovery and revision-conflict retry in both Story interfaces | Passed: six Playwright tests; desktop and mobile captures |
| Root TypeScript check and production build | Passed |
| Client boundaries, repository data safety and diff whitespace | Passed |
| Standalone web-next package type check | Failed on the previously documented, unchanged `source-authoring-panel.ts:773` union-property error; no new error reported |
| Live-provider quality and production-campaign canaries | Skipped: outside these local targeted fixes; release promotion gates remain unchanged |

Browser validation used the repository's Playwright workflow because the Browser skill/plugin was not available. The local Vite servers required execution outside the filesystem sandbox after configuration loading was denied inside it. Fixtures supplied the real endpoint response shapes; these browser checks do not claim a live database-backed browser session.

Screenshots: [legacy desktop](assets/generation-integrity-diagnostics/legacy-profile-recovery-editor-1440.png), [legacy mobile](assets/generation-integrity-diagnostics/legacy-profile-recovery-editor-390.png), [new interface desktop](assets/generation-integrity-diagnostics/web-next-profile-recovery-editor-1440.png), [new interface mobile](assets/generation-integrity-diagnostics/web-next-profile-recovery-editor-390.png).
