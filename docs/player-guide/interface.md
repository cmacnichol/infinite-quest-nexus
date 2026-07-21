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
- **Or type any action you want below** accepts original actions.
- **➜ Take action** submits the action to the Story Engine.

You cannot submit a new canonical turn while browsing an older scene. Return to the latest turn or use the explicit restart/branch workflow.

## Main menu

The player menu provides links or controls for:

- **Provider Setup**
- **World Management**
- **Current World Setup**
- **Save Story File**
- **Export to Markdown**
- **Export to HTML**
- **Activity Log**

**Current World Setup** is a read-only view of the campaign's pinned world version, character, premise, background, rules, statistics, and trackers.
