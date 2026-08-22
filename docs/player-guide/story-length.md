# Story response length

Each campaign stores a **Default story response length** independently from the provider's maximum output limit. It is the default for new narration, not a permanent limit on every turn.

| Preference | Intended narration size |
| --- | --- |
| Brief | 250–450 words |
| Standard | 450–900 words |
| Long | 800–1,200 words |
| Extended | 1,200–2,000 words |

Change the campaign default in the selected campaign's Nexus management panel and select **Save campaign**.

When submitting a turn from either the web-next or legacy **Story** view, the compact **Turn length** control appears beside the turn composer controls. It starts at **Campaign default — <Profile>** and uses the saved campaign preference for that submission. You may instead select **Brief**, **Standard**, **Long**, or **Extended** for just the submitted turn.

- The selected override is captured with the submitted action and applies to that turn only; after the server durably attaches a successful turn, the control resets to the current campaign default.
- If submission fails, the selected override remains in the composer so you can retry without reselecting it.
- Editing the latest accepted turn to replace it can choose its own per-turn profile. The retry flow also returns you to the composer, where you may choose a different profile before submitting the replacement.
- **Begin Story** remains automatic and uses the campaign default; it does not add a browser-selected override.
- When Auto mode asks you to confirm an action or generated choice, the chosen Turn length stays with that confirmation. Generated-choice Auto submissions use the currently selected choice.

The ranges are soft pacing goals, not guaranteed exact output word counts. Provider limits, recovery, and scene needs still apply. The text profile's **Maximum output** remains a hard provider request ceiling and should be large enough for the selected effective profile plus structured response data.
