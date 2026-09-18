# Phase 04 provenance handoff

## Completed runtime fences

- `943d6af8` preserves an applied fact-format repair through later scene, event, and continuity review gates. It also lets an authorized full Retry offer a fresh repair plan when its replacement primary response is complete but has malformed fact formatting.
- `3868d156` adds `factFormatRepairApplications` to private orchestration. Each event records the job and repair-receipt identity plus the plan, source response, raw-output reference, producing request, raw and repaired-result hashes, and provider configuration hash. The application write is atomic with the applied draft and current review state. Exact replays are idempotent; a different event for the same job/review/revision is rejected.
- The PostgreSQL load guard validates every retained event against exactly one retained repair receipt and the actual job scope. A current applied draft requires exactly one matching event. This prevents deletion, duplication, or valid-shaped rebinding of application history from reaching provider or canonical writes.

## A07 evidence map

| Acceptance case | Runtime fence | Evidence scope |
| --- | --- | --- |
| Raw output, request, and plan tampering | `prepareFactFormatRepair` and `applyAuthorizedFactFormatRepair` bind raw bytes, request fact IDs, protected fields, plan hashes, and repaired output before application. | Unit table `generation-executor-adapter.test.ts` first proves its intact authorized repair reaches the applied save and one canonical commit without another primary dispatch. It then alters each surface and proves recoverable rejection before an applied orchestration save, a second primary dispatch, or a canonical commit. The plan row recomputes the altered plan hash and receipt so the checkpoint remains schema-valid; the pure fact-format tests cover deterministic planning and replay. |
| Stale campaign/base/world and narration correction | Claimed payload loading compares the immutable generation base and scoped world/campaign authority before execution. | Real PostgreSQL: `generation-execution-repository.integration.test.ts` tests `does not load a claimed job after its snapshotted authority base changes` and `keeps the existing narration-correction source fence`; review persistence also rejects owner/campaign/base/protocol checkpoint mismatch. |
| Foreign owner and provider configuration | Review/receipt, saved draft, and provider configuration fences use the actual generation job rather than caller or current review identity. | Real PostgreSQL review scope test plus executor unit `rejects an authorized legacy format repair after its provider configuration changes before an applied write or primary redispatch`; composed foreign owner/campaign repair coverage is in the continuity integration matrix. |
| Unseen, inactive, foreign, or otherwise invalid fact supersession | Commit validates the fact was rendered to the provider, active at the base, and in the job's owner/campaign/world scope. | Real PostgreSQL: `generation-execution-repository.integration.test.ts` table test `rejects a %s without accepting a turn or mutating Chronicle`. |

## A08 no-write boundary

The execution-repository supersession table's `acceptedAndChronicleSnapshot` compares accepted turns, campaign state, canonical facts, and accepted Chronicle rows for the target and every relevant foreign scope before each rejected commit. The composed continuity matrix uses its `acceptedAuthoritySnapshot` for the same complete authority boundary around review-scope and repair failures, including `rejects a foreign owner and an actual foreign campaign repair scope without accepted writes`. The review-persistence applied-receipt table proves the earlier load boundary: each schema-valid receipt/scope tamper becomes `generation_checkpoint_incompatible` with the accepted-turn count unchanged before any provider or commit phase.

The unit tests prove deterministic parsing and binding only. The PostgreSQL and composed tests are the evidence for durable no-write behavior.
