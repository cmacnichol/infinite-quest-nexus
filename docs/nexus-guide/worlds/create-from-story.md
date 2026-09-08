# Create a world from a story or chapter

Use **World Management → From story or chapter** to create a reviewed draft from one pasted chapter or one UTF-8 `.txt` or Markdown file. This workflow is for a bounded source, not PDF, DOCX, OCR, URLs, or a collection of documents.

The source may contain at most 1 MiB of UTF-8 text and 200,000 Unicode code points. Nexus rejects malformed, binary, empty, NUL-containing, or oversized input. It removes one UTF-8 BOM and normalizes line endings once; all paragraph labels, code-point coordinates, and the retained SHA-256 hash refer to that normalized text. Nexus never clips a chapter to make it fit. If the chosen provider budget would need more than 200 extraction chunks, the proposal stops with a larger-context requirement instead of processing only an initial portion.

Choose the final paragraph that may contribute to the starting world. The visible default is the end of the supplied text. Text after the selected boundary is retained only while the un-applied proposal is retained; it is never sent to source extraction or synthesis and cannot become starting canon through this workflow.

Faithful extraction is the default. Each stated or inferred candidate has an exact passage and paragraph reference for you to inspect. A matching quotation shows textual support, not that the model's interpretation is correct. Review every fact, uncertainty, conflict, and optional expansion before continuing. Inferred and invented candidates are separate and are not accepted by default. Select zero to twenty playable-character facts; a zero-character draft is valid, although it cannot start a campaign until a playable character is added.

Extraction, review, and synthesis are durable proposal stages. You can refresh, resume a retained proposal, retry a recoverable stage, or discard it. Saving a fact review and applying an already reviewed proposal are provider-free actions. A source capability pause blocks new source intake, source retries, and synthesis, but keeps an owned retained proposal available for inspection, fact review, explicit apply, cancel, and discard. It does not alter published versions or existing campaigns.

Applying creates one new editable draft after normal revision and source-review checks. Story or chapter intake cannot target or update an existing draft. It never publishes a version or starts a campaign. The accepted source prefix, its evidence, provenance, selected boundary, and roster evidence become a `sourceMaterial` appendix in the saved world content. Rejected candidates, raw provider responses, prompts, credentials, and operational job state do not.

Unapplied proposals expire after seven days without an execution or user mutation; opening or listing one does not extend that deadline. Discard and expiry clear the source input, plan, review, stage outputs, and failures. Applied jobs retain their idempotency receipt for 30 days, while the accepted appendix remains with the draft or published version.

See [Create a world](./create.md), [import and export worlds](./import-export.md), and [Durable AI authoring operations](../../runbooks/ai-authoring.md).
