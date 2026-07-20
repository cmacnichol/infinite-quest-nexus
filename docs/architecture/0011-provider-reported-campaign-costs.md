# ADR 0011: Provider-reported campaign cost ledger

## Status

Accepted.

## Decision

Infinite Quest Nexus stores provider-reported charges in the append-only `provider_cost_events` ledger. Every row is owner- and campaign-scoped and may additionally reference an accepted turn and the generation, image, or Chronicle job that caused the call.

The ledger records only an explicit, valid cost returned by the provider. Nexus does not infer a charge from token counts or a model pricing catalog, and it does not create zero-cost rows for LM Studio or other responses that omit cost data. An explicitly reported zero remains valid provider accounting.

Story turn cost includes all reported calls attributed to the accepted generation job, including private assessment, event evaluation, narration, repair/recovery, context retrieval, and optional extension calls. Completed illustrations and unambiguously single-turn memory embedding batches also attach directly to the turn. Billed work that never produces an accepted turn remains campaign-level so campaign totals reflect actual spend.

Rewinding a campaign clears deleted turn references through `ON DELETE SET NULL` but retains the historical campaign charge. Creating a separate campaign does not copy cost events because copied story content does not represent newly incurred spend.

API amounts are decimal strings. Current UI surfaces only a discreet turn amount and campaign totals; a dedicated cost reporting page is intentionally deferred and must use the same ledger rather than introducing new counters.

## Consequences

- Campaign totals can exceed the sum of visible accepted turns because failed generations, context previews, and mixed-turn reindex batches remain campaign-only.
- Historical text charges cannot be reliably backfilled because earlier adapters discarded cost fields.
- Provider response IDs and local call IDs make worker persistence idempotent without collapsing distinct billed retries.
- Cost telemetry stays independent from authoritative story state and never prevents unsupported local providers from generating stories.
