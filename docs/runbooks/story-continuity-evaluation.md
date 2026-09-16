# Story continuity evaluation

The deterministic evaluator runs real PostgreSQL generation, acceptance, and next-turn replay against a local synthetic text provider. It does not measure live model quality. Story Memory stays off by default; enforcement promotion requires the separate [rollout gates](story-memory-rollout.md).

## Deterministic execution

Use the isolated database procedure in [Testing](../workflows/testing.md), then run:

```powershell
corepack pnpm evaluate:story-continuity --mode deterministic --allow-local-test-db --output docs/review/story-continuity-evaluation.json
```

`--allow-local-test-db` authorizes only the configured integration harness. A custom isolated harness may be supplied with `--integration-config path/to/config.ts`; never point it at an authoritative campaign database. The command requires all 120 measured samples and fails when tests skip or no aggregate report is produced.

The versioned corpus has 20 scenarios, two deterministic repeat identifiers, and three modes: baseline (review off), observe, and repaired. All modes use the same R3 context capability and held-out candidate for each scenario/repeat. Repeat identifiers are not claims of independently randomized model samples. Teacher-forced and rollout trajectories remain separate, producing six report strata. Wrong prior rollout history is retained as persisted; oracle labels never repair the supplied source.

The harness captures actual source records, candidate records, producing request bodies, source manifests, accepted state and subsequent replay. It scores source availability, retrieval, final serialized inclusion, accepted narration, replacement state and replay separately. Identity, content hashes, normalized parent text and exact excerpt ranges bind evidence. Missing sources are not counted as model mistakes. Omission warnings concern missing required replacement content; unsupported replacements and narration contradictions have separate records. Some dimensions overlap (for example, present-but-ignored evidence can also cause an omission).

Operational measurements include latency, token/cost fields, extra calls and repair rate. Fake-provider token usage and zero cost describe the fixture only. Independent blinded labels must identify the assessor, frozen label version and rubric version; absent labels are reported as skipped, never as a quality pass. There are no pooled cross-trajectory quality scores.

Raw request/state artifacts are opt-in with `--private-artifact-dir` and `--run-id`. The directory must be absolute, outside the repository and public-serving directories; existing artifacts are not overwritten. Only sanitized aggregate results should be committed.

## Explicit live replay

Live execution is a separate opt-in operation. It replays a saved self-contained **non-streaming main request** from an already completed job in an authorized copied campaign. It never creates a generation job or accepts returned story state. A streamed, chained, recovery or changed-provider request is refused; prepare another copied fixture using the ordinary application flow. The evaluator checks distinct source/copy IDs, common owner/world version, the saved request hash and the complete current serialized provider settings. Operator authorization records the copy's provenance; it is not authentication.

Supply normal runtime database/provider credentials through existing configuration, not command-line values. A complete invocation has this shape (replace placeholders and choose explicit ceilings):

```powershell
corepack pnpm evaluate:story-continuity --mode live --live `
  --source-campaign SOURCE_UUID --campaign-copy COPY_UUID --generation-job JOB_UUID `
  --provider PROVIDER_UUID --model MODEL --scenario-version HELDOUT_VERSION `
  --max-calls 1 --max-input-tokens INPUT_CEILING --max-output-tokens OUTPUT_CEILING --max-cost-usd COST_CEILING `
  --input-usd-per-million INPUT_PRICE --output-usd-per-million OUTPUT_PRICE `
  --source-authorization AUTHORIZATION_REFERENCE --access-policy OPERATOR_REVIEW_TEAM `
  --run-id UNIQUE_RUN_ID --private-artifact-dir ABSOLUTE_PRIVATE_DIRECTORY `
  --output PRIVATE_AGGREGATE_REPORT_PATH
```

Each call reserves the full serialized input byte bound, pinned maximum output and declared price before dispatch. Transport failures consume their reservation. Wire mismatches or reported usage above the reservation stop further calls. No automatic fallback, retry or response chain is used. This budget relies on accurate provider pricing and limits; the tool cannot reverse usage already incurred by an endpoint violating its contract.

Live raw outputs and provenance remain in the private artifact. The report marks adjudication pending and `acceptedStateMutation: false`; it cannot establish enforcement readiness. Use the preregistered human assessment, scenario-clustered paired quality analysis and provider/input-mode strata specified in the implementation plan before promotion. No live provider run was performed during this implementation.

Apply the private-artifact retention and dry-run cleanup procedure in [Story Memory rollout](story-memory-rollout.md#private-evidence-and-cleanup).
