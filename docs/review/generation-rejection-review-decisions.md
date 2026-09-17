# Generation rejection review: final documentation decisions

## Scope

This follow-up changes only the release verification documentation. It corrects
the unit total from 3,697 to 3,698 and describes the 103-file integration
evidence as segmented Windows/Linux coverage: 976 passing tests and 120 skips.
It does not claim that the full Windows integration command passed, and no
application suites were rerun for this documentation-only change.

## Final review result

The final whole-branch review found no functional findings. The two evidence
wording corrections and this decision record address the final review's
documentation findings.

## Implementation decisions

1. **Ruling: all agents Terra as explicitly requested; user authorized complete implementation, no publishing or main integration.** This followed the requested execution model and delivery boundary. If wrong, the work could have used an unauthorized model or published/integrated changes outside scope.
2. **Ruling: Bash helper lacks basename/dirname here; equivalent PowerShell workspace and brief extraction used.** PowerShell was the available compatible shell path for the helper work. If wrong, the workflow would fail on unavailable shell utilities or create an incomplete extraction.
3. **Ruling: keep existing main edits untouched; frozen lockfile dependencies installed successfully under approved escalation.** This preserved unrelated main-checkout work and used the pinned dependencies. If wrong, unrelated edits could be lost or validation could run against dependency drift.
4. The Task 1 review found journal historical gate incompatibility and missing full base identity. **Ruling: address both now. Detail projection was also Task5 scope, but add a safe static reason-code projector now so public contract consumers cannot accidentally expose private strings; richer validated fiction detail remains Task5.** This made the public contract safe before the later richer-detail work. If wrong, public consumers could expose private reviewer text or the journal gate would remain incompatible.
5. **Ruling: execute Task 4 commit guard immediately after Task 2 and before Task 3 worker wiring. Task 3 final Keep integration needs the Task 4 commit waiver to succeed; Task 4 can test seeded private checkpoints after Task 2. This avoids an intermediate worker implementation that claims acceptance before commit supports it. Final scope and eight task deliverables are unchanged.** The order put the durable acceptance guard in place before worker behavior depended on it. If wrong, a worker could report acceptance before the commit path could enforce it.
6. **Ruling: main-Keep prefix preservation applies to continuation under that authorization; a later explicit replacement retry can supersede it while retaining the journal. Task4 must not permanently enforce every historical Keep against all future candidates, which would block authorized retries.** This preserves the accepted prefix while allowing a later user-authorized replacement. If wrong, a valid replacement retry could remain blocked indefinitely.
7. **Ruling: new-workflow primary dispatch uses persisted started/reserved marker; reclaim without complete result opens existing structure/output_incomplete review with no typed candidate and Keep disabled. Explicit review retry authorizes one dispatch; no second consent mechanism. Legacy jobs lacking marker retain old recovery behavior. Reason: attempts cannot distinguish lease reclaim from explicit retry; cost if wrong is recovery workflow rework, not silent regeneration.** This distinguishes recovery from explicit user consent and retains compatibility for old jobs. If wrong, recovery needs redesign; it must not silently issue a new provider request.

## Verification

- `rg -n "3,698|Clear coverage was executed|Final whole-branch review" docs/review/generation-rejection-review.md` confirmed all requested documentation statements.
- The PowerShell local Markdown-target check resolved all six links in the review document.
- `git diff --check` exited 0.
- No unit, integration, browser, build, or live-provider command was rerun because this update changes documentation only.

## Evidence correction commit

`8dbd178a33f716e3193e1f61b041c3d97861a8f1` (`docs: correct generation rejection review evidence`).
