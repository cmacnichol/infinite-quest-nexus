# Phase 04 composed repair matrix handoff

## Evidence

`corepack pnpm exec vitest run --config vitest.integration.config.ts tests/integration/story-continuity-review.integration.test.ts` ran against the dedicated real PostgreSQL integration database at the integrated Phase 04 working tree. The JSON result recorded **71 passed, 0 failed**.

The test-only checkpoints are:

- `833fb40b test: expand repair workflow matrix`
- `15f36b34 test: fence repaired event extensions`
- `62f09bdf test: cover repaired retry decisions`
- `dc85b035 test: assert repair application history`

## Covered composed behavior

`story-continuity-review.integration.test.ts` directly queries accepted turns, campaign state, canonical facts, and Chronicle records. It proves those accepted-authority rows do not change while a fact-format offer is pending, its receipt is authorized, a repair is rejected, or a reclaim is waiting. It also uses actual distinct owner and campaign fixtures for the foreign-scope rejection.

| Checklist area | Real PostgreSQL evidence |
| --- | --- |
| A04–A05, A08–A10 | One primary call, a separately counted semantic review, exact narration/non-fact preservation, canonical-fact acceptance, one repair receipt, and one immutable `factFormatRepairApplications` event. The event remains through a later enforce continuity conflict and matching event-extension resume. |
| A06 | Complete provider JSON with `finish_reason: length` and supported malformed facts remains repairable; the same malformed facts with invalid Story Direction choices receive an inert v1 structure gate instead. |
| A07 | Foreign owner and actual foreign campaign scope tampering stop with an unchanged accepted-authority snapshot. Other bound-field tamper cases live in the provenance integration suite. |
| P01–P03 | Off makes no semantic request; observe and enforce retain their review behavior; an enforce conflict after a repaired candidate opens the normal continuity gate without accepted writes or another primary request. |
| P04–P07 | Action and Story Direction each run append and replace-latest repair cases. |
| P08 | A persisted after-event extension resumes only when its main-draft/request binding matches the transformed main; a tampered binding stops recoverably without accepted writes or a further provider request. |
| P09 | An optional illustration enqueue error does not undo acceptance and a later resume does not enqueue it again. |
| D01–D06 | Before decision, after receipt, after applied checkpoint, after semantic checkpoint, before commit, and after commit acknowledgement loss reclaim with retained primary raw/request/source identity, one application event, one repair receipt, no extra primary call, and one accepted turn. Before durable commit accepted authority remains unchanged; acknowledgement loss keeps the single committed snapshot. |

## Reachable retry route

The composed retry test covers the reachable full-primary sequence: first malformed primary offer, explicit **Retry**, replacement primary request, second format-repair offer, and explicit format repair. Its final application record binds the replacement primary response, raw-output reference, producing request, and provider fingerprint.

An already applied format repair cannot return to a full-primary Retry in the same job: later continuity, event, and scene decisions authorize their bounded repair stages. Therefore the integration suite does not manufacture a second applied fact-format event through an unreachable path. Historical multi-event ledger validation belongs to the bounded durable-checkpoint/adapter coverage that exercises retained event records without inventing a runtime transition.
