# Configure a campaign

The selected campaign provides:

- **Campaign title**
- **Status**: Active or Archived
- **World version**
- **Text provider profile**
- **Default story response length**
- **Turn control style**

Select **Save campaign** after changing editable settings.

The response-length preference guides narration size and remains independent from the provider profile's maximum-output ceiling. When the provider reports request costs, **Reported provider cost** summarizes the durable campaign ledger separately for **text generation**, **image generation**, and **semantic memory**, with a campaign total for each reported currency. It can include failed, rewound, or unattributed provider calls that are not visible as accepted turns. Local or unsupported providers are not represented as estimated zero-cost calls.

Configure semantic retrieval under **Memory and context** and optional art under **Campaign illustrations**. Those roles do not automatically inherit the story text endpoint or credentials.

**Player actions only** fixes the player to Action mode. The three flexible styles expose Auto, Action, and Scene direction and determine the initial selection and ambiguous-input fallback. Changing this setting affects new submissions; accepted turns and recoverable jobs keep their resolved mode.

Auto classification uses the system-default Intent provider when explicitly configured, otherwise this campaign's effective Story text provider. The Intent provider is a system-wide optimization and is not assigned to individual campaigns. See [Turn intent classification](../providers/turn-intent.md).
