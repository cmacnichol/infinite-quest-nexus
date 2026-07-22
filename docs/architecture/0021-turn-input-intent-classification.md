# ADR 0021: Typed turn input and optional intent classification

- Status: Accepted
- Date: 2026-07-22

## Context

A detailed player entry can describe either an attempted action or facts that must occur in the next scene. Treating every entry as a `current_player_action` leaves this distinction implicit. Models can mistake polished scene direction for prior story text and advance past the requested events. Making every detailed statement authoritative would create the opposite problem by bypassing uncertainty and mechanics.

Campaigns also differ in how much narrative control they grant players. Any automatic decision must remain fast, recoverable, auditable, and separate from story generation.

## Decision

Every submitted turn resolves to one durable type:

- **Action** is player intent or an attempt. Private mechanics may resolve its outcome.
- **Scene direction** contains required current-turn events and details. Narration must cover those beats before advancing; normal action assessment is skipped.

Flexible campaigns expose **Auto**, **Action**, and **Scene direction**. Auto is a request-selection state only. Before creating the generation job, Nexus classifies it as `action`, `scene`, `mixed`, or `uncertain`, resolves it to Action or Scene direction, and persists the resolved type and source. Explicit modes, generated choices, and opening actions bypass classification. Retries reuse the stored resolution.

Campaigns choose actions-only or a flexible style with Auto, Action, or Scene direction selected first. Ambiguous classification uses the campaign fallback; the Auto-first style falls back to Scene direction to preserve described facts.

Auto classification uses an explicitly enabled system-default **Turn intent classification** provider when one exists. Otherwise it uses the campaign's effective Story text provider. A sole Intent profile is not an implicit default. If the Intent call fails, Nexus retries once through Story text; if both calls fail, it uses the campaign fallback without blocking story generation. The Intent provider never generates narration or validates story output.

The prompt protocol supplies only the active Action or Scene contract near the submitted text. Scene validation may request one bounded rewrite from the Story text provider when required beats are missing. Sanitization must not silently replace a detailed entry with a generic continuation.

Classification audit data stores an input hash, result, provider source, and safe diagnostics rather than a duplicate raw entry. Portable exports retain campaign control style and per-turn resolved modes, but exclude classification records, confidence, provider assignments, models, and credentials.

## Consequences

- Detailed scene facts have an explicit enforceable path and are no longer confused with prior narration.
- Action campaigns retain mechanics-mediated play, while flexible campaigns can mix authorship styles turn by turn.
- Auto adds a provider call before some turns, but a small low-temperature model can handle it and failure degrades safely.
- Provider role constraints, migrations, request contracts, prompt protocol versioning, UI recovery state, imports, and tests must change together.
- Existing campaigns and older imports default to Action, preserving previous semantics.

## Alternatives considered

One free-form mode with more prompt wording would not tell the model whether asserted outcomes are authoritative. Two permanent text boxes would add clutter and make mobile composition awkward. Always using heuristics would be brittle for mixed prose; always using the story model would prevent operators from assigning a faster small model.
