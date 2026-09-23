# Campaign continuity and history

## Browse accepted history

Select the turn/view control to open **Turn History & State**. Select a turn card to inspect its recorded state, then use the actions at the bottom of the dialog to inspect the state again, jump to that scene, or restart/branch from an earlier turn. Browsing does not mutate the campaign.

Use **← Previous turn** and **Next turn →** for sequential reading. **Continuous Reading** in the user profile controls presentation, not authoritative history.

## Rewind the current campaign

Select an earlier history card, choose **Restart / Branch from Here…** at the bottom of the dialog, then choose **Reset this campaign** when you intend to discard later accepted story progress from this campaign.

This is destructive campaign history editing. Read the confirmation carefully. Provider-reported cost events remain an audit ledger even when related turns are no longer visible.

## Create a separate branch

Choose **Create separate campaign** to preserve the original campaign and create another story path from the selected accepted boundary. The new campaign remains scoped to its own ledger, state, jobs, and Chronicle memory.

## Undo the latest turn

Use **Undo latest** only when you intend to rewind the most recent accepted boundary. The command does not edit narration in place; it changes which accepted boundary is current.

## Supporting-character history

In the legacy Story reader, open **Setup → Characters** to search the roster and inspect supporting characters. When editing is enabled, use **Add character**, or select a character to update its name, aliases, and sparse profile. The main character opens its existing profile editor. The replacement Story interface and automatic discovery are still planned.

Leaving a field blank and saving makes that blank your explicit override. **Use discovered value** removes your override and restores supported recorded information, if any. Pin and ignore are saved preferences; they do not affect generation until cast context is implemented. Sources and edit history distinguish observations, claims, and your edits, and link back to source turns.

Failed saves keep your draft. If another edit or campaign change causes a conflict, **Compare latest** shows the saved version and **Reapply my changes** explicitly carries your changes onto that version. Closing or cancelling a changed draft asks before discarding it. Editing is unavailable while generation is active or when the operator disables it; saved characters remain readable.

When cast records exist, branching copies only the identities and edits supported at the selected boundary. Rewind and undo discard later character edits along with later story progress.

Correcting or replacing narration invalidates character facts based on the old narration. Explicit user overrides remain authoritative at retained boundaries, including intentionally blank fields. Campaign and System Archives preserve cast identity and edit history even when editing is disabled. Cross-world transfers retain the characters' original provenance rather than treating them as entities authored in the destination world.

Operator details are in [Campaign cast operations](../runbooks/campaign-cast.md).
