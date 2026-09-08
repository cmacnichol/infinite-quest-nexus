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
