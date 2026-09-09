# Troubleshoot the player

## The first scene does not generate

Open **Setup → Provider Setup** and confirm that an enabled **Story text** profile has a selected model. A new zero-turn campaign submits its opening action automatically after basic dashboard creation or when first opened, so configure the provider first.

## I expected an Auto choice

Auto classification and its provider role are retired. Select **Action** or,
where the current player interface offers it, **Story Direction** before
submitting. A Story Direction campaign accepts Story Direction only.

## Requested story events were not followed

Confirm that the turn was submitted as **Story Direction**. It requests the
stated events subject to world canon and corrected campaign continuity, and
skips independent semantic scene coverage. Action treats prose as intent that
may be resolved rather than as a requested event.

## A choice submits before I can edit it

Open the user profile, clear **Auto-submit story turns when selecting a choice**, and select **Save Profile**.

## I refreshed during generation

Wait for the player to reconnect to the durable job. Do not submit a duplicate action. If needed, return to the dashboard and select the same campaign card again.

## The story completed but no image appeared

This is expected when illustrations are disabled or the independent image job fails. Story acceptance does not depend on image success. Ask the campaign administrator to inspect **Campaign illustrations** and retry the image job if appropriate.

## I am viewing an older scene and cannot act

Return to **Viewing latest** to continue the current campaign. To continue from an older boundary, open **Turn History & State**, select the earlier turn, and use **Restart / Branch from Here…** at the bottom of the dialog.

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
