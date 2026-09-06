# Optional illustrations

Illustrations run independently from story acceptance. Accepted-turn jobs start after commitment; with streaming segmentation, provisional images can begin while narration is still being generated. They are attached to the turn on acceptance. See the [illustration lifecycle](../concepts/illustration-pipeline.md#provisional-streaming-path-and-open-contract-conflict) for the unresolved validation-boundary conflict.

## What image generation can affect

An image job can add or replace artwork for an accepted turn. It cannot:

- Accept or reject story narration
- Change campaign state
- Rerun the story turn
- See private mechanics, scratchpads, raw responses, or rejected narration
- Reuse text-provider credentials automatically

## View and regenerate an image

When a scene has artwork, its image controls can open **Edit image prompt**. Review the fiction-only prompt and select **🖼️ Regenerate image**. The story and choices remain unchanged.

## Failures

If image generation is disabled, unavailable, incompatible, or unsuccessful, the accepted story remains complete. An administrator can retry a recoverable image job from the campaign's **Campaign illustrations** section without regenerating narration.
