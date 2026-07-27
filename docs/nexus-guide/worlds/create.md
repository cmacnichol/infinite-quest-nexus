# Create a world

1. Open **Setup → World Management**.
2. Enter a **New world title**.
3. Optionally select **Generate cover** to queue a vertical world cover through the default image provider.
4. Select **New world**.

Nexus creates one editable draft owned by the current server-resolved user. The draft remains unpublished until you explicitly create a version.

Complete **Overview**, **Lore**, and **Mechanics & Characters**, then select **Save draft**. See [Edit a world draft](./edit-drafts.md) and [Author playable characters](./characters.md).

If no default image provider and model are configured, the world still creates successfully; configure one later and generate the cover from the Overview tab.

## Generate with the text provider

When you generate a world preview, the first text-provider call creates the world fields and compact playable-character seeds. Nexus then generates and, if needed, recovers each complete character profile independently. Every call uses the configured maximum output tokens on the selected text-provider profile, which keeps an individual profile from consuming the world call's output budget. The preview is returned only after every profile passes validation; if any profile fails, Nexus does not create or save a partial world.
