# Natural conversation prompt update — 2026-09-23

Follow-up to the [turn-generation tone audit](turn-generation-tone-audit-2026-09-23.md), authorized by the request to update the current prompt using it as the base.

## Changes

- Revised [shared prose guidance](../../packages/contracts/src/story-prompt.ts) to request believable conversation, character-specific vocabulary and rhythm, natural sentence variety, and emotional beats expressed through speech and behavior. Solitary and nonverbal scenes do not require dialogue.
- Replaced rigid sentence splitting and the broad prohibition on historical prose imitation with targeted guidance against excessive clause chains and circular restatements. Retained meaningful hesitation, repetition, callbacks, and established voice.
- Distinguished world atmosphere from prose delivery and allowed plausible present-scene speech and reactions within established authority and requested scope.
- Protected unaffected narration during recovery. Added the shared guidance and explicit minimal-change instructions to the [continuity repair template](../../packages/contracts/src/prompt-library.ts).
- Retained the existing output schema, mandatory authority contracts, fiction/mechanics separation, event-extension prefix preservation, and frozen protocol constants. Template content hashes change the runtime prompt identity for newly captured work; existing jobs retain their snapshots.

## Live application

Applied seven campaign overrides through `PUT /api/v1/prompt-library/overrides` for **Mindy and Mike (Branch Turn 14)**: story writer, output-limit recovery, mechanics recovery, schema recovery, scene-coverage rewrite, event extension, and continuity repair.

Each uses the revised catalog text plus this campaign-specific direction:

> Campaign prose direction: Use natural, engaged narration and believable character conversation. For prose style only, this direction replaces clinically detached narrative delivery requested by the world tone. Preserve the world's bleak, darkly ironic atmosphere, established facts, and mandatory world rules. Let each character speak in their own voice; do not make every speaker sound clinical or formal. This changes presentation, not character identity, history, or outcomes. During repairs, apply it only to passages that require correction; preserve unaffected narration.

All seven were read back with matching SHA-256 hashes and campaign scope; protected templates had valid compatibility acknowledgement. Effective story-system hash: `1fe143751a98c342a383bd98f33f9790a58f57cda9c5c9068ef9b7e30ca53798` (6,755 characters).

The live campaign update does not require an application rebuild. Shared defaults are updated in the checkout but have not been redeployed. Other campaigns and application-level overrides were not changed. No generation was started, and no accepted narration, world version, provider setting, or retrieval setting was edited.

## Verification and limitations

- RED: eight expected failures before implementation (six delivered prompt previews, continuity repair preservation, and template identity).
- GREEN: 116 tests passed across eight files: prompt-library, prompt, story-only-prompt, preset-prompt, story-output, story-continuity-review-contracts, story-continuity-review, and scene-coverage.
- Checked template size limits, placeholders, exact effective API readbacks, and compatibility acknowledgements. Six templates passed the deployed preview route. Continuity repair is outside that route's accepted key list, so it was verified through local schema validation and successful save/readback instead; no preview API change was made.
- `git diff --check` passed for the changed code. Existing unrelated working-tree edits were preserved.
- No live-provider A/B run or browser rendering was performed. Tests prove instruction delivery and contracts, not improved narrative quality.

## Local rollback reference

The ignored `tmp/turn-tone-update-plan.json` preserves each prior effective prompt, source, hash, and compatibility requirement. To reverse the live change, restore the prior story-system campaign override through the API with an acknowledgement for its exact content hash; reset the other six newly created campaign overrides to restore their inherited defaults. Re-read the live library first to avoid overwriting later edits. The temporary operational helper is `tmp/turn-tone-update.mts`; it is not part of the application or a deployment requirement.
