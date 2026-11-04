# Prompt Library

Open **Setup → Prompt Library** to manage the instructions Infinite Quest Nexus sends to text and image models. The library includes story writing, mechanics, validation, world authoring, imports, and illustration prompts.

Application defaults apply to future work everywhere. Runtime prompts can also have a campaign-specific override; it takes precedence only in that campaign. Choose the campaign directly on the Prompt Library page. World-authoring and import prompts intentionally remain application-wide.

Filter by category or text, then use the arrow controls or horizontal scrolling to move through the one-row prompt rail. The source badge identifies whether the current value is shipped, application-wide, or campaign-specific. Engine-critical prompts show an additional warning.

Use **Preview full request** to see the server-built system, structured-input, recovery, or image-prompt sections with safe sample data. The preview updates after edits, estimates token use, identifies unresolved variables, and never contacts a provider. Templates may use only their listed variables and must retain every required variable.

Use **Restore shipped default** for an application override or **Use inherited application prompt** for a campaign override. Unsaved edits are clearly marked and must be saved or discarded before changing prompt, scope, or campaign. Saving a prompt does not alter an already queued, running, or retried generation: those jobs retain the effective prompt captured when they were created. Existing output validation and fiction-only safeguards remain active even when you customize a template.

## End Scene boundaries

The shipped **Story writer** prompt recognizes **End Scene** in turn instructions as a boundary the narration must not pass. For example: `Continue their conversation at the locked door. End Scene: the door remains closed; nobody enters or discovers what is inside.` You can also place `End Scene` after the last requested beat.

A turn may stop before that boundary and leave the larger scene unresolved. Repeat the boundary in each subsequent turn until you want to advance. This is model guidance, not a deterministic stop or an additional validation check.

Existing application or campaign Story writer overrides take precedence over the shipped prompt; add the scene-boundary paragraph to those overrides if needed. Newly queued jobs capture the updated prompt and its content hash, which changes the provider-chain identity. Previously queued jobs retain their frozen prompt. No output-schema or wire-protocol change is required.
