# Create a world

1. Open **Setup → World Management**.
2. Enter a **New world title**.
3. Optionally select **Generate cover** to queue a vertical world cover through the default image provider.
4. Select **New world**.

Nexus creates one editable draft owned by the current server-resolved user. The draft remains unpublished until you explicitly create a version.

## AI-assisted proposals

When durable AI authoring is enabled for the instance, a proposal can resume after a refresh or worker restart. Review generated content before applying it to a draft; applying remains revision-checked and never publishes a world or changes a campaign. You can retry a recoverable proposal while it is retained.

Proposals expire after seven days of inactivity. Opening or listing a proposal does not extend that deadline. If the capability is disabled, use the synchronous compatibility flow; existing unexpired durable proposals are retained only for their original deadline. See [Durable AI authoring operations](../../runbooks/ai-authoring.md).

For a source-linked draft, choose **From story or chapter** and follow [Create a world from a story or chapter](./create-from-story.md). That flow extracts only through your selected paragraph boundary, requires fact review before synthesis, and keeps publication and campaign creation explicit.

Complete **Overview**, **Lore**, and **Mechanics & Characters**, then select **Save draft**. See [Edit a world draft](./edit-drafts.md) and [Author playable characters](./characters.md).

If no default image provider and model are configured, the world still creates successfully; configure one later and generate the cover from the Overview tab.

## Generate with the text provider

When you generate a world preview, the first text-provider call creates the world fields and compact playable-character seeds. Nexus then generates and, if needed, recovers each complete character profile independently. Every call uses the configured maximum output tokens on the selected text-provider profile, which keeps an individual profile from consuming the world call's output budget. The preview is returned only after every profile passes validation; if any profile fails, Nexus does not create or save a partial world. Your concept and draft fields remain available to review and retry; validated failures identify the affected stage or field and include a correlation ID. If the text provider is unavailable, use **Provider Setup** to open `/nexus/#providers` before retrying.
