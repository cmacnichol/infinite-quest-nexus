# Player interface

## Story header

The story header shows:

- **Turn N** for the current scene position
- **Viewing latest** or **Viewing turn N**
- **Ready** or **Busy** generation state

Selecting the turn/view controls opens **Turn History & Navigation**.

## Story scene

An accepted scene can contain:

- The submitted action
- Narration
- Generated choices
- An optional collapsed roll outcome
- Optional generated artwork
- Provider-reported cost when the provider supplies it

Private mechanics, trigger reasons, scratchpads, parser diagnostics, and model reasoning are not story narration.

## Player controls

- **← Previous turn** and **Next turn →** browse accepted scenes.
- **Undo latest** rewinds the current campaign from its latest accepted boundary after confirmation.
- **Retry latest generation** is available for the applicable latest-generation recovery path.
- The turn editor accepts original actions or scene direction.
- Flexible campaigns show **Auto**, **Action**, and **Scene direction** above the editor. Actions-only campaigns show a locked Action badge.
- The label, example text, helper message, and submit button change with the selected mode.
- A character counter shows the remaining turn-input limit.

When Auto resolves clearly, the player briefly shows **Auto → Action** or **Auto → Scene direction**. Mixed or ambiguous input opens a confirmation with explicit Action and Scene choices rather than guessing silently.

You cannot submit a new canonical turn while browsing an older scene. Return to the latest turn or use the explicit restart/branch workflow.

## Universal navigation

The slim navigation bar remains visible while you play:

**Dashboard** and **Story** form the primary destination group on the left side of the navigation. A divider separates them from the Story-specific Setup, Export, and About menus. The selected destination and open menu are highlighted without caret indicators.

- Select the themed logo or **Dashboard** to browse worlds and campaigns.
- **Story** returns to the active campaign, or opens the empty Story page when none is active.
- **Setup** groups provider, world, campaign, Import, Chronicle, and current-world controls.
- **Export** is Story-only and offers **Markdown** or **PDF with images**. Available scene illustrations are carried into the readable export.
- **About** displays application and release information.

The story-specific activity and turn controls remain in the player interface. **Setup → Current World Setup** is a read-only view of the campaign's pinned world version, character, premise, background, rules, statistics, and trackers.
