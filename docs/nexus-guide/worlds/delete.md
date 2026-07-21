# Delete a world or version

## Delete an unused published version

1. Select an explicit numbered **Published version**.
2. Open **More actions** and select **Delete selected version**.
3. Review dependency status.
4. Type `Version N` exactly and confirm.

Nexus refuses deletion when any current or historical campaign dependency exists. Deletion detaches applicable import or fork provenance without renumbering later versions.

## Delete an entire world

::: danger Permanent deletion
World deletion removes the draft, all remaining versions, and world-owned provenance. It cannot be undone from the application.
:::

Delete or otherwise resolve every dependent campaign first. Then:

1. Select the world.
2. Open **More actions** and select **Delete world**.
3. Type the exact world title.
4. Confirm permanent deletion.

Export the intended versions and verify an operator backup before deleting important canon.
