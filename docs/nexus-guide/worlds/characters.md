# Author world characters

Campaign creation requires a published version with at least one complete playable character.

## AI-assisted character proposals

When the instance enables durable AI authoring, character proposals can be resumed and reviewed after a refresh or retry. Applying a reviewed proposal updates only the selected current world draft with its expected revision; it does not publish the world or alter campaign snapshots. Proposals expire after seven days of inactivity, and reading one does not extend retention. See [Durable AI authoring operations](../../runbooks/ai-authoring.md) for enablement and rollback behavior.

## Add manually

1. Open **Mechanics & Characters**.
2. Select **+ Add character**.
3. In quick-create, enter **Character name**, choose **Use in campaigns**, and optionally add **Role** and **Personality**. Playable and Both characters need a story detail; Supporting characters can start with only a name.
4. Select **Continue in detailed editor** for the full profile or mechanics. Continue keeps incomplete input and makes no save or provider request.
5. Select **Add to world draft** or **Apply to world draft** when ready.
6. Save the parent world form to persist the roster.

Existing characters open in the detailed editor. Use the section navigation to edit identity, personality and voice, appearance, current situation, history and notes, or mechanics. On narrow screens, use the **Section** selector and previous/next actions. **Preview sheet** displays the local draft; it is not a narrator prompt preview.

Statistics and starting trackers remain separate from fiction. Choosing Supporting hides mechanics without discarding them. If retained mechanics fail validation, the editor opens Mechanics and keeps it visible while you correct the fields. Imported source guidance remains read-only; **Organize notes with AI…** is in History and notes.

Statistic notes, tracker starting values and update rules accept multiple lines. Remove controls name the affected row. **Undo removal** restores the most recent removed row, including its position and imported details; another removal replaces that Undo, and applying or closing the editor clears it.

Cancel, Back and Escape use the unsaved-change decision. **Apply and leave** applies the character locally; the parent world still needs saving. Browser Back resolves the character draft before the parent world draft. After Apply, focus returns to the character’s roster action, or the roster heading if filters hide the character. Browser refresh or a crash does not recover unsaved manual edits.

## Generate a reviewed candidate

When an effective default text model is configured:

1. Expand **Draft a character with AI** in quick-create or the detailed editor's Overview.
2. Enter a **Character concept or prompt**.
3. Select **Generate character**.
4. Review every populated field.
5. Select **Add to world draft** or **Apply to world draft**, then save the parent world.

Generation never persists the candidate automatically. Unsaved premise and canon editor values may guide the candidate as bounded generation-only context. If either is empty, Nexus shows **World context is incomplete** and requires **Go back** or **Generate anyway**. If generation cannot be validated, your prompt and candidate fields remain available to review and retry; validated failures identify the affected stage or field and include a correlation ID. If the text provider is unavailable, use **Provider Setup** to open `/nexus/#providers` before retrying.


## World characters and campaign Characters

Published world characters are reusable starting canon. Story's **Characters** workspace manages the campaign's protagonist and supporting cast separately. Campaign corrections and discoveries do not edit the world draft or another campaign. Changing a world draft does not update existing campaign snapshots; publish and explicitly migrate when that is intended.


Characters can be Playable, Supporting, or Both. Supporting characters need only a name and retain any mechanics if you later change their use. For Supporting and Both, choose whether they are selected by default in a new campaign and whether they are always included in narrator context. Duplicate a roster entry to create an independent copy, and use the move controls to set roster order. Existing characters remain Playable until changed. A world needs a playable character before a campaign can start.

Search the roster by name, alias or role. The All, Playable, Supporting and Both filters match use exactly; they do not change the authored order. Clear filters to reorder characters. Summaries prefer personality, then background, then retained legacy guidance, and shorten only the displayed text. The roster limit remains 1,000 characters; a blocked addition keeps the new character draft open.

## Convert existing entities

In **Mechanics & Characters**, select **Convert entities** when the draft contains unlinked people, NPCs, or character entities. Review the mapped guidance and properties that stay on the entity, select the people to convert, and give each a unique roster name. If you rename someone, choose whether to retain the former name as an alias. Shared names and aliases remain ambiguous for matching.

Conversion adds Supporting characters to the local world draft and leaves the original entities and their relationships in place. The new characters are not selected by default for starting cast. Save the world to persist the conversion; close the draft without saving to discard it. You can edit the new characters and organize their guidance after saving the draft.

## Suggest a starting cast

In **Mechanics & Characters**, choose **Suggest cast**. Enter an optional direction and request three to eight character seeds. Review their names, roles and concepts, then choose **Expand selected**. The default text provider receives one seed request and one expansion per selected seed, plus any repair calls.

You can stop after the current character, retry a single failed row, edit a finished suggestion in the character editor, or drop it. **Add selected to draft** adds the reviewed Supporting characters with their starting-cast option enabled. **Save world** persists the roster. Unadded suggestions last until the dialog closes or the page reloads. Manual character entry remains available when the provider is offline.
