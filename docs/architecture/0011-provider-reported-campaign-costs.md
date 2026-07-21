# ADR 0011: Provider-reported campaign cost ledger

## Status

Accepted.

## Decision

Infinite Quest Nexus stores provider-reported charges in the append-only `provider_cost_events` ledger. Every row is owner- and campaign-scoped and may additionally reference an accepted turn and the generation, image, or Chronicle job that caused the call.

The ledger records only an explicit, valid cost returned by the provider. Nexus does not infer a charge from token counts or a model pricing catalog, and it does not create zero-cost rows for LM Studio or other responses that omit cost data. An explicitly reported zero remains valid provider accounting.

Story turn cost includes all reported calls attributed to the accepted generation job, including private assessment, event evaluation, narration, repair/recovery, context retrieval, and optional extension calls. Completed illustrations and unambiguously single-turn memory embedding batches also attach directly to the turn. Billed work that never produces an accepted turn remains campaign-level so campaign totals reflect actual spend.

Authoritative server-side rewinds (`POST /campaigns/:id/rewind`) power all client undo (`undoLatest`) and retry (`retryLatest`) operations. Rewinding a campaign clears deleted turn references through `ON DELETE SET NULL` (`turn_id IS NULL`) but retains the historical campaign charge under the original campaign ID without creating duplicate replacement campaigns or branching. To protect against race conditions, clients pass `expectedCurrentTurnNumber`; mismatches return HTTP 409 without mutating local state. Rewinds targeting turn zero (`targetTurnNumber: 0`) restore the `initial_state_snapshot` recorded at campaign creation or import (`campaign_state.initial_state_snapshot`), allowing fresh turn 1 generation while maintaining historical cost ledger entries. Creating a separate campaign via explicit branching (`choice === "copy"`) does not copy cost events because copied story content does not represent newly incurred spend.

API amounts are decimal strings. The campaign cost summary (`getCampaignCostSummary()`) surfaces discreet turn amounts, total campaign spend, and groups surviving non-turn or rewound charges under `historicalAndUnattributedOperations`. Current UI displays turn amounts, historical/unattributed operations, and campaign totals; a dedicated cost reporting page is intentionally deferred and must use the same ledger rather than introducing new counters.

## Consequences

- Campaign totals can exceed the sum of visible accepted turns because rewound turns (`turn_id IS NULL`), failed generations, context previews, and mixed-turn reindex batches remain campaign-only under `historicalAndUnattributedOperations`.
- Authoritative server-side rewinding preserves exact ledger auditing across undo and retry operations while preventing duplicate campaigns and client-database divergence.
- Historical text charges cannot be reliably backfilled because earlier adapters discarded cost fields.
- Provider response IDs and local call IDs make worker persistence idempotent without collapsing distinct billed retries.
- Cost telemetry stays independent from authoritative story state and never prevents unsupported local providers from generating stories.
