# Generate your first story turn

Infinite Quest creates story turns through the durable Nexus Story Engine.

## Watch the first generation

Loading a zero-turn campaign queues its opening action automatically. The progress display moves through friendly stages such as:

1. **Queued**
2. **Reading state**
3. **Resolving action**
4. **Writing scene**
5. **Saving turn**

Where supported, narration appears with **Streaming Live** while the durable job continues. Scrolling away reveals **Follow live** so you can resume automatic following.

Only validated output is accepted. A failed or rejected generation cannot update campaign state or Chronicle memory.

## Submit the next turn

After the scene completes:

- Select a generated choice, or
- Choose **Auto**, **Action**, or **Scene direction** when the campaign is flexible, then enter original text and submit it.

Pressing Enter submits the typed turn. Use Shift+Enter for a new line.

Choice selection submits immediately by default. To make a choice populate the action editor instead, open the user profile and clear **Auto-submit story turns when selecting a choice**.

Use Action for what the character attempts. Use Scene direction when described events are required facts the narration must dramatize. Auto decides between them immediately before submission and asks for confirmation when the text is ambiguous. See [Turn input modes](../player-guide/turn-input-modes.md).

## Confirm acceptance

The header advances to the next **Turn N** and shows **Viewing latest**. The accepted action and narration are now part of the append-only campaign ledger. Chronicle derives fiction-only memory from that accepted content.

Optional rolls may be displayed in a collapsed result, but private resolution details, parser diagnostics, rejected output, and hidden trackers do not enter narration or Chronicle memory.

## Refresh safely

If you refresh while a generation is pending, the player reconnects to the durable job and resumes progress. Do not submit the same action again while the existing job is active.

Continue with the [Player Guide](../player-guide/).
