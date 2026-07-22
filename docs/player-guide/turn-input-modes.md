# Turn input modes

Infinite Quest can interpret a turn as a player attempt or as scene direction. The campaign's **Turn control style** determines which modes the player offers and which one it selects initially.

## Action

Choose **Action** when you are declaring what the player character tries to do. The Story Engine may assess uncertainty, resolve private mechanics, and narrate the result.

Include dialogue, manner, priorities, and intended approach, but do not assume an uncertain outcome has already succeeded. For example: “I distract the sentry with a complaint about the gate roster while Mira slips behind the cart.”

Generated choices and a campaign's opening action always use Action mode.

## Scene direction

Choose **Scene direction** when the entered events and details are facts the next narration must include. The Story Engine treats the described beats as happening in the current turn, writes the story around them, and only then advances to their aftermath. It must not skip them as though they were earlier narration.

Use this mode for directed dialogue, reveals, arrivals, environmental changes, or a well-described sequence whose outcome the campaign author has decided. Scene direction does not run the normal action-resolution assessment. Do not use it to inject system instructions, hidden mechanics, or facts that conflict with campaign canon.

## Auto

Choose **Auto** when either input style is allowed and you want Nexus to classify the text before submission. Auto resolves to Action or Scene direction; it is never sent to story generation as a third prompt mode.

- A clear or probable classification proceeds and briefly shows **Auto → Action** or **Auto → Scene direction**.
- A mixed or ambiguous entry pauses for confirmation. Select **Submit as Action**, **Submit as Scene**, or return to the editor.
- If classification is unavailable, Nexus applies the campaign's configured fallback. **Flexible — Auto** falls back to Scene direction so that detailed events are not silently skipped.

Classification runs only when Auto is submitted, not on every keystroke. Generated choices and opening actions bypass it.

The editor and API accept up to 12,000 characters for one turn input. The Story Engine keeps that input in the fixed prompt envelope and removes lower-priority Chronicle memories first when fitting the model context. It does not silently truncate the submitted Action or Scene direction: if the provider's available input window cannot fit it, generation stops with an explicit context-budget error.

## Campaign control styles

Campaign administrators can choose:

| Control style | Player behavior |
| --- | --- |
| **Player actions only** | Action is fixed; Auto and Scene direction are unavailable. |
| **Flexible — Auto** | All modes are available; Auto is selected initially. |
| **Flexible — Action first** | All modes are available; Action is selected initially and is the ambiguous-input fallback. |
| **Flexible — Scene direction first** | All modes are available; Scene direction is selected initially and is the ambiguous-input fallback. |

Changing the campaign setting affects future submissions. Accepted turns retain their resolved mode so retries, recovery, and history do not reinterpret the original input.

Your profile also has a **Default turn input style for new campaigns** preference. It seeds the creation selector only; changing it never modifies an existing campaign or accepted turn.

## Privacy and portability

Nexus stores the resolved mode with the durable turn. Classification audit data uses an input hash rather than a second copy of the entered text. Provider credentials, classification records, confidence values, and provider assignments are excluded from portable campaign exports. Imported older campaigns default to Action when they do not carry mode metadata.

See [Turn intent classification](../nexus-guide/providers/turn-intent.md) for provider selection and failure behavior.
