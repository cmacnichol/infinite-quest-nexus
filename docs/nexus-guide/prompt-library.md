# Prompt Library

Open **Setup → Prompt Library** to manage the instructions Infinite Quest Nexus sends to text and image models. The library includes story writing, mechanics, validation, world authoring, imports, and illustration prompts.

Application defaults apply to future work everywhere. Runtime prompts can also have a campaign-specific override; it takes precedence only in that campaign. Choose the campaign directly on the Prompt Library page. World-authoring and import prompts intentionally remain application-wide.

Filter by category or text, then use the arrow controls or horizontal scrolling to move through the one-row prompt rail. The source badge identifies whether the current value is shipped, application-wide, or campaign-specific. Engine-critical prompts show an additional warning.

Use **Preview full request** to see the server-built system, structured-input, recovery, or image-prompt sections with safe sample data. The preview updates after edits, estimates token use, identifies unresolved variables, and never contacts a provider. Templates may use only their listed variables and must retain every required variable.

Use **Restore shipped default** for an application override or **Use inherited application prompt** for a campaign override. Unsaved edits are clearly marked and must be saved or discarded before changing prompt, scope, or campaign. Saving a prompt does not alter an already queued, running, or retried generation: those jobs retain the effective prompt captured when they were created. Existing output validation and fiction-only safeguards remain active even when you customize a template.
