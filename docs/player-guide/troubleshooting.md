# Troubleshoot the player

## The first scene does not generate

Return to Nexus **Providers** and confirm that an enabled **Story text** profile has a selected model. A new zero-turn campaign submits its opening action automatically when loaded, so configure the provider first.

## Auto chose the wrong input mode

Use the visible **Action** or **Scene direction** selector before submitting when the distinction matters. If Auto reports mixed or ambiguous input, review the text and choose the intended mode in the confirmation. Generated choices and opening actions intentionally use Action.

## Auto classification is slow or unavailable

Auto first uses the explicitly default **Turn intent classification** provider, if configured, and otherwise the campaign Story text provider. Ask the administrator to check that provider's health or select a smaller classifier model. If classification cannot complete, Nexus uses the campaign fallback; it does not discard the text or use the Intent provider for narration.

## Detailed events were skipped

Confirm that the turn was submitted as **Scene direction**. Action mode treats prose as intent that may be resolved rather than as guaranteed facts. Scene direction requires the narration to cover the described beats before moving to their aftermath.

## A choice submits before I can edit it

Open the user profile, clear **Auto-submit story turns when selecting a choice**, and select **Save Profile**.

## I refreshed during generation

Wait for the player to reconnect to the durable job. Do not submit a duplicate action. If needed, return to Nexus, select the same campaign, and use **Load story** again.

## The story completed but no image appeared

This is expected when illustrations are disabled or the independent image job fails. Story acceptance does not depend on image success. Ask the campaign administrator to inspect **Campaign illustrations** and retry the image job if appropriate.

## I am viewing an older scene and cannot act

Return to **Viewing latest** to continue the current campaign. To continue from an older boundary, open **Turn History & Navigation** and use **Restart / Branch from Here…**.

## The model changed and appears to have lost continuity

The next request always bootstraps from database state, but a tight context budget can select a more compressed Chronicle view. Ask the administrator to inspect the campaign context preview and text model context settings.

## Collect useful diagnostics

Record:

- Campaign and turn number
- Job identifier when displayed
- Correlation identifier from an error
- Friendly generation stage
- Selected provider profile and model name, without its key
- Whether the problem persists after reloading the same campaign

Never paste provider credentials, private reasoning, or an unredacted private campaign into a public issue.
