# Configure a campaign

The selected campaign provides:

- **Campaign title**
- **Status**: Active or Archived
- **World version**
- **Text provider profile**
- **Default story response length**
- **Turn control style**
- **Memory level**: Off, Standard, Enhanced, or Max (default)

Select a campaign, then use **Overview**, **Story behavior**, **Illustrations**, **Chronicle**, and **Usage & more** in the settings rail.

**Save campaign** covers **Overview** and **Story behavior** fields other than memory level. Memory level, migration, illustrations, Semantic Retrieval, preview, and deletion retain separate actions.

The response-length preference guides narration size and remains independent from the provider profile's maximum-output ceiling. When the provider reports request costs, **Reported provider cost** summarizes the durable campaign ledger separately for **text generation**, **image generation**, and **semantic memory**, with a campaign total for each reported currency. It can include failed, rewound, or unattributed provider calls that are not visible as accepted turns. Local or unsupported providers are not represented as estimated zero-cost calls.

Configure Semantic Retrieval under **Chronicle** and optional art under **Illustrations**. Those roles do not automatically inherit the story text endpoint or credentials.

**Player actions only** fixes the player to Action. **Action** selects Action
initially and can retain an explicit Story Direction control in the player.
**Story Direction** accepts Story Direction only and selects the story-only
workflow for new jobs. There is no Auto style or classifier fallback.

Changing between Action and Story Direction uses the existing settings save and
is blocked while generation is unresolved. A queued, recoverable, or accepted
job keeps its stored policy and is never converted by a later campaign save.
Story Direction preserves stored RPG and pending-event data while skipping
mechanics and independent scene-coverage work.

## Choose a memory level

Use the **Memory level** dropdown in campaign settings or the Story player's
campaign tools/settings. Legacy dropdown changes save immediately; the new
interface provides a separate **Save memory level** or **Save Campaign Memory**
button. Both interfaces read the same saved value.

- **Off** uses the legacy context path without continuity review.
- **Standard** improves authoritative character/world context and history retrieval.
- **Enhanced** also reserves space for a recent window of up to three accepted turns.
- **Max** also supports verified excerpts and optional evidence-based continuity review.

Check **Enable continuity review** with Max memory to review each new draft before
acceptance. Review adds a model request and can pause a turn for a Keep or Retry
decision. Uncheck it to skip that extra review; structure and mechanics validation
still apply. The checkbox is disabled by default for new campaigns, branches and
imports. Existing saved review choices remain unchanged by the update.

Memory level and the checkbox apply to newly queued turns. Pending jobs retain
their frozen policy, including saved drafts awaiting review. Legacy checkbox changes
save immediately; campaign overview uses **Save memory level**.

Story context remains a separate limit. When review is enabled, context selection
reserves room for review instructions, selected evidence, the future draft and the
same configured output allowance used for story generation. Optional history may
be omitted to fit. Required authority is never truncated, and the final review
request is checked again because token counts are estimates.

Existing custom prompt overrides may require the current protocol acknowledgement
in the Prompt Library before new generation can start. Disabled options indicate
that an operator has restricted the available levels.

After this release, an existing application writer or event-extension override
shows *Needs acknowledgement* once. Acknowledge it to make it effective for
every campaign without a campaign copy.

## Correct current continuity

Use **Edit State** in the legacy Story Player, **Campaign Tools → Edit Campaign State** in the new Story Player, or **Current state** in the new campaign editor. The editor always loads the latest campaign state, even while you are reading an earlier turn. Historical inspection remains read-only.

Edit the continuity summary, private scratchpad, open threads, and canonical facts. Each fact/thread has its own multiline row; a newline does not create a new fact. IDs are managed automatically, so editing unrelated fields preserves existing fact identities. Private scratchpad text is for fictional continuity only; it is never indexed as Chronicle memory or sent for illustrations.

Saving affects future generation only. It does not rewrite or regenerate accepted narration, mechanics, or pictures. Wait for active or recoverable generation to finish or be resolved before saving. A stale-state conflict preserves your draft; reload the current state before reconciling and saving it again.

Corrections become authoritative immediately. Only changed Chronicle documents need background indexing when enabled; scratchpad-only changes need none. Unavailable embeddings use the existing retrieval fallback. A correction that cannot fit the configured story context budget causes an explicit generation error instead of silently discarding your correction; shorten it or increase the campaign's context budget.
