# Create your first world

A world draft is editable. Publishing creates an immutable numbered version that a campaign can safely depend on.

## 1. Create the draft

1. Open `http://localhost:8080/nexus/` and select **Worlds**.
2. Enter a **New world title**.
3. Select **New world**.

The new draft opens in World Library.

## 2. Describe the world

Complete the relevant editor tabs:

- **Overview**: **Title**, **Genre**, **Tone**, and optional **Release notes**
- **Lore**: **Premise**, **Background and canon**, and **Opening action**
- **Mechanics & Characters**: world **Rules** and the **Playable character roster**

The opening action is queued automatically when a new zero-turn campaign is loaded. If it is blank, Infinite Quest uses `Begin the adventure.`

Select **Save draft** after authoring changes. Draft saves use a revision check so one editor cannot silently overwrite a newer update.

## 3. Add a playable character

1. Open **Mechanics & Characters**.
2. Select **+ Add character**.
3. Enter **Character name** and **Character guidance**.
4. Add any **RPG statistics** and **Starting trackers**.
5. Select **Add character**.

When an enabled default text model is available, **Generate with default text model** can propose one character from a concept or prompt. Generation fills the form only. Review every field and explicitly save the character.

If **Premise** or **Background and canon** is empty, Nexus warns that world context is incomplete. Return to add that context or explicitly choose **Generate anyway**.

A draft can be saved while incomplete, but campaign creation requires a published version with at least one complete playable character.

## 4. Publish an immutable version

1. Select **Save draft**.
2. Select **Publish version**.
3. Confirm the publication.

The result appears under **Published version** as a numbered snapshot. Later draft edits do not change this version, and they do not change campaigns already created from it.

You can publish another version after revising the draft. Version numbers increase and are not reused even if an unused version is later deleted.

Continue with [Create your first campaign](./first-campaign.md).
