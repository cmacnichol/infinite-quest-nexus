# Generation format and recovery verification

Implementation branch: `codex/generation-format-recovery`, based on `8cf83359`. Final code and regression commit: `ed868dc0`.

This change follows the [three-patch plan](../superpowers/plans/2026-09-18-generation-format-recovery.md). Implementation and independent reviews use Terra agents. Production jobs, accepted turns, deployment, and live providers are outside this verification.

## Review recovery and diagnostics

An ordinary retry against a pending review returns an actionable typed conflict without mutating the job. Updated clients reconcile authoritative review state and require an explicit review decision. A recovered structure failure does not display unvalidated narration or unrelated context advice. Accepted history remains visible.

Optional field diagnostics come from the unique attempt matching the pending candidate's producing response, scoped to job and owner. Only finite field names and fixed issue codes cross the public boundary. Missing, ambiguous, stale, or malformed detail falls back to the generic review explanation; raw validation text stays private.

Patch 1 was independently reviewed after fixes, through `1598063e`. Focused evidence: 202 unit tests, seven PostgreSQL cases, typecheck, and 26 browser passes with one configured skip. Two subsequent targeted browser passes cover exact accepted-turn preservation before and after retry.

Patch 2 was independently reviewed after fixes, through `7aa2a8a4`. Focused evidence: 19 unit tests, eight PostgreSQL cases, typecheck, and 28 browser passes with one configured skip. Coverage includes a later unrelated attempt and malformed diagnostic canaries through the API and both rendered clients.

## Provider normalization and prompt identity

Current-provider parsing supplies empty arrays only when `superseded_facts` or `canonical_fact_updates` is absent. It unwraps canonical-fact objects only when their sole property is a string `content`. The unchanged strict schema and mechanics validation then run. Null or malformed arrays, metadata-bearing objects, missing full replacements, and invalid authority remain failures. Historical/import parsing and raw provider evidence remain separate.

New prompts explicitly distinguish current-turn fact deltas from complete continuity replacements and use protocol v15. Frozen v13/v14 identities are recognized separately. Compatible legacy jobs retain captured prompt bytes. Older v14 Story Memory jobs and mismatched frozen identities stop before provider dispatch with `prompt_protocol_upgrade_required` / `discard_and_reenqueue`; their snapshots are never silently relabeled or composed using new instructions. No migration or backfill is required.

Parser RED evidence captured four failures before implementation, then 44 focused passes. Subsequent prompt/worker coverage and the combined results below supersede that intermediate count.

Real PostgreSQL fixtures now establish prior accepted facts and threads, accept each supported normalized shape with one story dispatch, preserve exact raw response bytes, and verify authority in the next turn's request. Four invalid-shape fixtures prove no changes to accepted turns, campaign state, canonical facts, or Chronicle: metadata-bearing fact objects, missing scratchpad, mechanics text inside a wrapper, and an unsupplied supersession UUID. Existing composed generation/review suites cover truncated output, explicit bounded retry, duplicate decisions, leases, replacement, and owner/campaign isolation.

Parser and prompt changes remain separately committed (`5ff7b093` and `72e3835d`); follow-up commits protect frozen jobs and complete composed coverage. Each patch received independent Terra review and correction rounds. The whole-branch review found no actionable P1/P2 issues, and a final scoped review closed the prior-state preservation gap at `ed868dc0`.

## Combined verification

| Check | Result |
| --- | --- |
| Windows `corepack pnpm test:unit --maxWorkers=4` | **Passed:** 3,726; 44 platform-gated skips. |
| Linux full unit inventory | **3,768 passed, one failed, one platform skip.** The failed notification timing assertion also fails on unchanged base `8cf83359`; see below. |
| PostgreSQL integration inventory on Linux | **1,207 passed, seven configured skips, no remaining failures**, across all 103 files plus ten targeted reruns after corrections. This is segmented evidence, not a claim of one uninterrupted final run. |
| Windows `corepack pnpm test:integration` | Stopped at file 55 on a source-authoring scheduling assertion. Its isolated rerun passed 2/2; the complete inventory is covered by Linux results above. Do not describe this as a full Windows pass. |
| `corepack pnpm check` | **Passed** on final committed code and tests. |
| `corepack pnpm build` | **Passed** after the last production change; existing bundle-size warnings remain. Later changes are tests/documentation only. |
| Both specified Playwright suites | **67 passed, one configured skip.** Both Story surfaces, desktop and mobile. |
| `git diff --check` and local documentation links | **Passed.** |

The Linux unit failure is `client-api-routes.test.ts` / “reconciles authoritative state within 15 seconds when a notification is dropped.” The assertion requires at least 14,500 ms but observed approximately 12,300 ms on both this branch and an isolated copy of base `8cf83359`. Its frames and read-count assertions pass. This unrelated baseline timing failure was recorded rather than changing stream behavior or weakening its test in this patch.

Linux integration reruns corrected runner prerequisites (local-only access to the disposable database and Chromium), refreshed current-protocol fixtures, and reran the affected generation suites. The Chronicle budget fixture's transient indexing failure passed in isolation. The seven integration skips are an opt-in historical-pool benchmark and six pre-existing context-payload known-failure probes. The browser skip requires an explicit web-awesome renderer; the default renderer was tested. The Linux unit skip tests unsupported-host behavior on a supported Linux host.

All commands used the pinned pnpm 12.4.1. A task-local Corepack shim kept nested build commands from selecting the machine's older pnpm. PostgreSQL fixtures used dedicated disposable databases and deterministic providers. The additional Linux containers, their volumes/network, and task-owned dev servers were removed after evidence was saved. Detailed logs and JSON results remain in the ignored worktree-local `.superpowers/sdd/2026-09-18-generation-format-recovery/` directory.

Both Story surfaces have synthetic desktop and mobile captures:

| Surface | Desktop | Mobile |
| --- | --- | --- |
| Legacy `/story` | [1440px](assets/generation-format-recovery/legacy-structure-review-1440.png) | [390px](assets/generation-format-recovery/legacy-structure-review-390.png) |
| Replacement `/app/story` | [1440px](assets/generation-format-recovery/web-next-structure-review-1440.png) | [390px](assets/generation-format-recovery/web-next-structure-review-390.png) |

Browser fixtures and deterministic provider responses verify application behavior; they do not establish live-model narrative quality. No production recovery, merge, push, or deployment is included.
