# Author playable characters

Campaign creation requires a published version with at least one complete playable character.

## AI-assisted character proposals

When the instance enables durable AI authoring, character proposals can be resumed and reviewed after a refresh or retry. Applying a reviewed proposal updates only the selected current world draft with its expected revision; it does not publish the world or alter campaign snapshots. Proposals expire after seven days of inactivity, and reading one does not extend retention. See [Durable AI authoring operations](../../runbooks/ai-authoring.md) for enablement and rollback behavior.

## Add manually

1. Open **Mechanics & Characters**.
2. Select **+ Add character**.
3. Enter **Character name** and **Character guidance**.
4. Add **RPG statistics** with **+ Add statistic** where needed.
5. Add **Starting trackers** with **+ Add tracker** where needed.
6. Select **Add character**.

Use **Edit character** to review and save changes or delete a draft character.

## Generate a reviewed candidate

When an effective default text model is configured:

1. Select **Generate with default text model**.
2. Enter a **Character concept or prompt**.
3. Select **Generate character**.
4. Review every populated field.
5. Select **Add character** or **Save changes**.

Generation never persists the candidate automatically. Unsaved premise and canon editor values may guide the candidate as bounded generation-only context. If either is empty, Nexus shows **World context is incomplete** and requires **Go back** or **Generate anyway**. If generation cannot be validated, your prompt and candidate fields remain available to review and retry; validated failures identify the affected stage or field and include a correlation ID. If the text provider is unavailable, use **Provider Setup** to open `/nexus/#providers` before retrying.


## World characters and campaign Characters

Published world characters are reusable starting canon. Story's **Characters** workspace manages the campaign's protagonist and supporting cast separately. Campaign corrections and discoveries do not edit the world draft or another campaign. Changing a world draft does not update existing campaign snapshots; publish and explicitly migrate when that is intended.


Characters can be Playable, Supporting, or Both. Supporting characters need only a name and retain any mechanics if you later change their use. For Supporting and Both, choose whether they are selected by default in a new campaign and whether they are always included in narrator context. Duplicate a roster entry to create an independent copy, and use the move controls to set roster order. Existing characters remain Playable until changed. A world needs a playable character before a campaign can start.

## Convert existing entities

In **Mechanics & Characters**, select **Convert entities** when the draft contains unlinked people, NPCs, or character entities. Review the mapped guidance and properties that stay on the entity, select the people to convert, and give each a unique roster name. If you rename someone, choose whether to retain the former name as an alias. Shared names and aliases remain ambiguous for matching.

Conversion adds Supporting characters to the local world draft and leaves the original entities and their relationships in place. The new characters are not selected by default for starting cast. Save the world to persist the conversion; close the draft without saving to discard it. You can edit the new characters and organize their guidance after saving the draft.

## Suggest a starting cast

In **Mechanics & Characters**, choose **Suggest cast**. Enter an optional direction and request three to eight character seeds. Review their names, roles and concepts, then choose **Expand selected**. The default text provider receives one seed request and one expansion per selected seed, plus any repair calls.

You can stop after the current character, retry a single failed row, edit a finished suggestion in the character editor, or drop it. **Add selected to draft** adds the reviewed Supporting characters with their starting-cast option enabled. **Save world** persists the roster. Unadded suggestions last until the dialog closes or the page reloads. Manual character entry remains available when the provider is offline.
