# Task 4C2 — Durable authoring, source, and illustration contracts

Date: 2026-09-20
Branch: `codex/native-openrouter-presets`
Approved base: `c30850b086dd9443377563df02e172dcfa25f507`

## Result

Task 4C2 now adopts the approved Task 4C1 response-contract seam in durable
authoring, source extraction/synthesis/character work, and illustration prompt
refinement. New bound jobs persist a strict version 3 snapshot containing the
safe request projection, route basis, complete frozen response-contract
closure, derived operation plans, and trusted operation prompts. Historical
authoring v1, plan-only authoring v2, illustration NULL, and plan-only
illustration v2 readers remain explicit compatibility branches.

Version 3 is deliberate. During final review, the new authoring fields were
found to share `version: 2` with the historical plan-only format. Removing the
new fields could therefore make a bound snapshot parse as historical v2.
This was discovered by source inspection rather than a baseline test run.
New bound authoring and illustration snapshots now use version 3, so removal of
one field or the complete new authority set cannot select the historical
reader. PostgreSQL and actual-adapter regressions prove rejection before the
prepared executor.

Native production admission remains disabled. This work composes and persists
the request graph but does not implement Task 5 physical transport or old-worker
fences.

## Implemented behavior

- Added neutral source extraction, source synthesis, source character, and
  illustration operation identities. Initial and repair operations remain
  logically distinct while each pair binds to one stable schema invocation
  key.
- Added operation-specific source schemas. Source character intentionally uses
  the same closed wire envelope as source synthesis because both actual
  consumers return `fields`, `characterFields`, and optional
  `expansionCandidates`; it retains a distinct schema name and operation
  identity.
- Prepared trusted Presets without consulting Model capability eligibility.
  Prepared concrete Models only with the exact current response-format
  advertisement and exact endpoint/model/route/schema verification tuple.
- Persisted full bound snapshots for both Presets and direct Models. Model
  snapshots contain no fabricated preset identity.
- Revalidated route-basis hashes, derived plans, the complete plan/prompt
  operation set, frozen contract closure, selection hash, invocation binding,
  and trusted prompts before inference.
- Froze ordinary profile settings, selected route, effective prompts, timeout,
  candidate limits, and safe request configuration at enqueue. Reclaim ignores
  later ordinary setting edits while current profile role, credential,
  authority revision, and endpoint identity still gate dispatch.
- Adopted the bound executor in actual source extraction, synthesis, and
  character callers for faithful and expand modes. Every actual caller retains
  its own initial and repair operation identity.
- Source chunk binary search uses a capacity-unchecked canonical render that
  still includes the frozen route, schema, plan, and trusted prompt. Only
  oversize search candidates use this form. The selected chunk must pass the
  checked serializer before executor dispatch.
- The exact successful selected source body is measured, checked, retained as
  `PreparedProviderRequest`, and dispatched. Native source accounting uses
  the repository token estimate plus its safety allowance.
- Repair cleanup measures the complete rejected draft first and may remove only
  that optional diagnostic when it overflows. The final checked repair body
  keeps the schema, protected input, and frozen repair prompt and is the body
  recorded and dispatched.
- Illustration prompt refinement uses the text route and a strict one-field
  `{"image_prompt":"..."}` envelope. Existing local fiction-only/mechanics
  validation remains after envelope parsing. Image provider selection,
  credentials, jobs, retries, and acceptance remain independent.
- The prepared executor continues to own transport retry behavior. Task 4C2
  did not restore schema stripping, `json_object`, legacy serialization, or a
  second outer routing loop.

## Per-consumer evidence

| Consumer | Preset | Model | Initial/repair and validation evidence |
| --- | --- | --- | --- |
| Durable standalone character | Real PostgreSQL reclaim after ordinary edits, current-authority rejection, full prepared body/audit | Real PostgreSQL inherited Model reclaim, no preset fields, exact verified schema body, authority rejection, tamper and downgrade rejection | Actual durable stage dispatch; Task 4C1 retains standalone semantic repair coverage |
| Source extraction | Actual faithful and expand stage dispatch | Actual faithful and expand stage dispatch with exact capability evidence | Both force malformed initial output and a repair; assert `source_extraction` / `source_extraction_repair`, stable invocation key, schema name, prompt once, and audit |
| Source synthesis | Actual faithful and expand stage dispatch | Actual faithful and expand stage dispatch with exact capability evidence | Both force initial then repair; assert distinct synthesis identities, synthesis schema, prompt once, and local closed-mapping validation |
| Source character | Actual faithful and expand stage dispatch | Actual faithful and expand stage dispatch with exact capability evidence | Both force initial then repair; assert distinct character identities, character schema, prompt once, complete reviewed selection, and local character/evidence validation |
| Illustration refinement | Actual adapter call with trusted closure | Actual adapter call with exact advertisement and verification | Both assert checked schema body, full audit, typed one-field envelope, rejection of plain/alias envelopes, and retained mechanics rejection |
| Illustration reclaim | Real PostgreSQL frozen Preset snapshot | Model request behavior is covered at the actual adapter; no live provider was used | Ordinary edits do not change the saved plan; plan tamper and v3 downgrade field removal fail before authority/executor |

Task 4C1 remains the approved evidence for actual world outline, seed character,
standalone character semantic repair, and organizer initial/repair behavior,
including terminal prepared failures that do not enter the historical outer
retry loop.

## TDD evidence

### RED

1. `corepack pnpm exec vitest run tests/unit/durable-authoring-response-contract.test.ts`

   **1 failed / 1 total.** The shared durable source/illustration preparation
   helper did not exist.

2. `corepack pnpm exec vitest run tests/unit/source-authoring-runtime-budget.test.ts`

   The new schema-aware source budget regression failed during binary-search
   rendering with:

   `ContextBudgetError: requires 2676 tokens but only 1944 are available`

   The checked serializer was rejecting oversize candidates before the chunk
   planner could split them. The correction added only a capacity-unchecked
   fully bound canonical render for search candidates. Selected initial and
   repair requests still require checked admission.

The v2-to-legacy downgrade risk was found during source review, not by a
baseline RED command. The fixed PostgreSQL and actual-adapter negative cases
are recorded below.

### GREEN

- `corepack pnpm exec vitest run tests/unit/authoring-stage-adapter.test.ts --reporter=dot`

  **47 passed in 1 file.** Includes 12 actual source caller cases:
  extraction/synthesis/character × faithful/expand × trusted Preset/verified
  Model, all forcing initial then repair.

- `corepack pnpm exec vitest run tests/unit/illustration-application-adapter.test.ts --reporter=verbose`

  **8 passed in 1 file.** Includes actual trusted-Preset and verified-Model
  full-contract calls, strict envelope checks, and the production
  fiction/mechanics validator.

- `corepack pnpm exec vitest run tests/unit/source-authoring-runtime-budget.test.ts`

  **12 passed in 1 file.** Includes schema bytes changing the chunk boundary,
  selected checked admission, successful measured/checked/dispatched body
  equality, prompt-once, token plus safety allowance, and final repair cleanup
  body equality.

- `corepack pnpm exec vitest run tests/unit/durable-authoring-response-contract.test.ts tests/unit/source-authoring-runtime-budget.test.ts tests/unit/authoring-stage-adapter.test.ts tests/unit/illustration-application-adapter.test.ts tests/unit/illustration-segmentation.test.ts --reporter=dot`

  **75 passed in 5 files.** This is the final commit-ready focused unit
  selection after the Model/Preset caller matrix and v3 downgrade fix.

- `corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/authoring-stage-execution.integration.test.ts --reporter=dot`

  **21 passed in 1 file** against the dedicated PostgreSQL harness. This
  includes Preset and direct-Model reclaim, ordinary edits, current-authority
  rejection, contract tamper, one-field v3 loss at the actual adapter, and
  persisted removal of all new v3 authority fields at the database reader.

- `corepack pnpm exec vitest run --config .superpowers/sdd/2026-09-18-native-openrouter-presets/vitest.integration.config.ts tests/integration/image-pipeline.integration.test.ts --reporter=dot`

  **17 passed; 14 skipped in 1 file.** The executed cases include illustration
  v3 persistence, first claim after ordinary edits, full prepared audit,
  plan tamper rejection, downgrade-field removal rejection, current authority
  checks, expired-lease reclaim paths, malformed snapshots, and independent
  Story/illustration behavior present in the executed selection.

  The 14 skipped tests are exactly the `secureGeneratedAssetsIt` cases
  guarded by `supportsSecureGeneratedArchiveStaging()`. That predicate is
  Linux-only and this run used Windows. They cover stale/cancelled image
  workers, lease replacement, row-lock cancellation, visual-reference
  artifact generation, multi-artifact persistence/replacement, world covers,
  retained generated assets, generated bytes, incompatible/failed/retried/
  exhausted image jobs, and Sogni polling. They are skipped platform cases,
  not passed checks.

  One final rerun first reported **1 failed, 16 passed, 14 skipped** because the
  new tamper fixture selected the lowest random UUID while the worker claims by
  `created_at`; an untampered sibling could therefore be claimed. The fixture
  now moves the selected row to the front of the production claim order. The
  immediate rerun returned the **17 passed, 14 skipped** result above.

- `corepack pnpm exec tsc --noEmit --incremental false --pretty false`

  **Passed** with the task PATH shim.

- `git diff --check`

  **Passed**.

No browser, live-provider, paid inference, production enablement, push, PR, or
main-checkout integration was performed.

## Task 5 handoff and remaining gates

Task 5 must:

- recognize bound authoring snapshot version 3 and bound illustration snapshot
  version 3 while retaining explicit historical authoring v1/v2 and
  illustration NULL/v2 behavior;
- implement the physical prepared transport, ordered candidate attempts,
  transport-owned retries, attempt accounting, availability fallback, and old
  worker fences;
- prove that the physical request body/hash is exactly the checked
  `PreparedProviderRequest` supplied here;
- keep production native admission off until those transport and worker-fence
  checks pass.

Optional embedding auto-enable/import behavior remains the separately assigned
future correction. It is not folded into Task 4C2.
