# Story interface coexistence smoke test

Use a disposable PostgreSQL campaign and the same server instance for the legacy
Story Player and the replacement Fold-out Story interface. Do not put campaign
text, prompts, private state, provider payloads, credentials, or screenshots of
private campaigns in this document or in the repository.

## Prerequisites

- A local API, worker, and PostgreSQL stack with a disposable campaign.
- The campaign has at least six accepted turns and, where applicable, image-job
  records.
- A browser session able to open both `/story/:campaignId` and
  `/app/story/:campaignId` against that same campaign.
- A log capture configuration that redacts secrets, prompts, narration, and
  private campaign state before evidence is attached.

For every row, record one of **Pass**, **Fail**, or **Blocked** and link only
sanitized evidence. A missing PostgreSQL service, browser session, provider, or
safe evidence capture is **Blocked**; it is never a pass by omission.

| # | Check | Status (Pass/Fail/Blocked) | Sanitized evidence |
| --- | --- | --- | --- |
| 1 | Create or select a disposable campaign with at least six accepted turns. | Blocked | Runtime campaign and PostgreSQL proof not available in this checkout. |
| 2 | Open `/story/:campaignId` and `/app/story/:campaignId` against that same PostgreSQL campaign. | Blocked | Browser and PostgreSQL proof not available. |
| 3 | Compare persisted turn numbers, effective narration, choices, world and character identity, current state, and image bindings. | Blocked | Requires a disposable campaign and sanitized comparison record. |
| 4 | Verify Auto, Comfortable, Wide, and Full width reading widths at desktop and mobile sizes. | Blocked | Browser visual proof not captured; no private-campaign screenshots were taken. |
| 5 | Navigate past the five-turn Campaign Spine window and open complete History. | Blocked | Requires a campaign with six or more accepted turns. |
| 6 | Combine duplicate choices with a personal draft and switch every allowed input mode. | Blocked | Requires browser interaction with a disposable campaign. |
| 7 | Submit one append generation, observe streaming, cancel a separate run, then resume or retry a recoverable run. | Blocked | Requires a configured text provider and runtime job evidence. |
| 8 | Correct accepted narration and prove the original ledger row, prompt, mechanics, state, and turn order remain unchanged. | Blocked | Requires PostgreSQL inspection and sanitized ledger evidence. |
| 9 | Retry the latest turn with an edited prompt and verify replacement rather than append semantics. | Blocked | Requires a disposable campaign and durable generation evidence. |
| 10 | Inspect historical state and prove Resolve Check is absent until Inspect State is explicitly opened. | Blocked | Requires browser and historical-state evidence. |
| 11 | Exercise one failed or disabled illustration case and one independent image retry while narration remains accepted. | Blocked | Requires image-provider or disabled-image runtime evidence. |
| 12 | Export Markdown, HTML, and PDF plus images. | Blocked | Requires a browser download/print run using disposable content. |
| 13 | Exercise Campaign Settings, Profile, keyboard-only dialog and disclosure closure, theme switching, and reduced motion. | Blocked | Browser accessibility evidence not captured. |
| 14 | Switch campaigns and verify no cross-campaign data appears. | Blocked | Requires two disposable campaigns and browser/runtime evidence. |
| 15 | Capture API and worker logs that omit secrets, narration, prompts, and private state. | Blocked | Sanitized runtime log capture not available. |

## Acceptance record

Do not change a row to **Pass** until its evidence is captured from the
disposable runtime. Keep raw logs, exports, screenshots, and database output
outside the repository. This initial record intentionally contains no browser
screenshots: the prior visual work did not use private local campaign content.
