# Configure a campaign

The selected campaign provides:

- **Campaign title**
- **Status**: Active or Archived
- **World version**
- **Text provider profile**
- **Default story response length**
- **Turn control style**

Select a campaign, then use **Overview**, **Story behavior**, **Illustrations**, **Chronicle**, and **Usage & more** in the settings rail.

**Save campaign** covers **Overview** and **Story behavior** only. Migration, illustrations, Semantic Retrieval, preview, and deletion retain separate actions.

The response-length preference guides narration size and remains independent from the provider profile's maximum-output ceiling. When the provider reports request costs, **Reported provider cost** summarizes the durable campaign ledger separately for **text generation**, **image generation**, and **semantic memory**, with a campaign total for each reported currency. It can include failed, rewound, or unattributed provider calls that are not visible as accepted turns. Local or unsupported providers are not represented as estimated zero-cost calls.

Configure Semantic Retrieval under **Chronicle** and optional art under **Illustrations**. Those roles do not automatically inherit the story text endpoint or credentials.

**Player actions only** fixes the player to Action mode. The three flexible styles expose Auto, Action, and Scene direction and determine the initial selection and ambiguous-input fallback. Changing this setting affects new submissions; accepted turns and recoverable jobs keep their resolved mode.

Auto classification uses the system-default Intent provider when explicitly configured, otherwise this campaign's effective Story text provider. The Intent provider is a system-wide optimization and is not assigned to individual campaigns. See [Turn intent classification](../providers/turn-intent.md).

## Correct current continuity

Use **Edit State** in the legacy Story Player, **Campaign Tools → Edit Campaign State** in the new Story Player, or **Current state** in the new campaign editor. The editor always loads the latest campaign state, even while you are reading an earlier turn. Historical inspection remains read-only.

Edit the continuity summary, private scratchpad, open threads, and canonical facts. Each fact/thread has its own multiline row; a newline does not create a new fact. IDs are managed automatically, so editing unrelated fields preserves existing fact identities. Private scratchpad text is for fictional continuity only; it is never indexed as Chronicle memory or sent for illustrations.

Saving affects future generation only. It does not rewrite or regenerate accepted narration, mechanics, or pictures. Wait for active or recoverable generation to finish or be resolved before saving. A stale-state conflict preserves your draft; reload the current state before reconciling and saving it again.

Corrections become authoritative immediately. Only changed Chronicle documents need background indexing when enabled; scratchpad-only changes need none. Unavailable embeddings use the existing retrieval fallback. A correction that cannot fit the configured story context budget causes an explicit generation error instead of silently discarding your correction; shorten it or increase the campaign's context budget.
