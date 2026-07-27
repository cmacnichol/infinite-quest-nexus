# ADR 0027: Generated world completion contract

## Status

Accepted

## Context

Generated worlds must be ready for campaign creation immediately, while portable and Infinite Worlds imports must preserve authored source material faithfully. Treating both workflows as the same kind of import either permits incomplete generated characters into authoritative storage or forces source imports to invent, discard, or reshape characters.

Generated characters serve both current campaign-readiness checks and consumers of structured character data. A character therefore is not complete when it has only prose guidance or only a structured profile.

Provider responses are untrusted and may be malformed, truncated, or structurally incomplete. Validation failures must be actionable without exposing provider output, user prompts, imported lore, credentials, or rejected values.

## Decision

Generated world creation uses a stricter completion contract than source-faithful imports. A generated world contains three or four distinct playable characters, and every character has both non-empty `characterText` guidance and a structured `profile`.

Provider output is normalized permissively before the completion boundary. Incomplete characters are discarded. When fewer than three complete characters remain, generation makes one bounded supplement request for the exact number of replacement characters needed. The supplement is validated and merged without exceeding four characters. Generic placeholder characters are forbidden.

`generateTemplateWorld` is the sole generated-world completion gate. Manual preview and CYOA automatic import both call it and rely on the same postcondition. Generated content is never persisted before this gate returns successfully.

Generated-world validation diagnostics expose only bounded issue paths, codes, and static messages. They do not include rejected values or source content.

Portable and Infinite Worlds imports remain source-faithful workflows. They retain every source character and are not required to synthesize or reduce the roster to three or four characters.

## Consequences

- A successfully generated preview and a generated world accepted by CYOA import have the same campaign-ready character guarantees.
- One bounded repair attempt can recover from incomplete roster output without creating fictional placeholder content or allowing unbounded provider retries.
- Failure occurs before authoritative persistence when generation remains incomplete.
- Generated-world diagnostics can identify structural problems without disclosing story content.
- Source imports preserve their original roster cardinality and character material even though generated worlds use stricter acceptance rules.

## Alternatives considered

Allowing `characterText` to be empty when a profile exists was rejected because current campaign-readiness and story-guidance consumers require the prose guidance. Requiring only `characterText` was rejected because structured-profile consumers require typed character data. Fabricating generic replacement characters was rejected because placeholders would become authoritative canon. Applying the generated-world roster contract to source imports was rejected because source-faithful imports must not silently discard or invent authored characters.
