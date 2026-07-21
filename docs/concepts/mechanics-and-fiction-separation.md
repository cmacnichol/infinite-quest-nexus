# Mechanics and fiction separation

Mechanics and narration travel through separate typed paths.

```mermaid
flowchart TD
  Action["Player action"] --> Mechanics["Private mechanics assessment"]
  Mechanics --> Private["Rolls, targets, modifiers, trigger reasons"]
  Mechanics --> Outcome["Sanitized diegetic consequence"]
  Outcome --> Narrative["Narrative model"]
  Narrative --> Validation["Mechanic-leak validation"]
  Validation --> Fiction["Accepted fiction"]
  Fiction --> Chronicle["Fiction-only Chronicle"]
  Fiction --> ImagePrompt["Fiction-only image prompt"]
  Private -. "never enters" .-> Chronicle
  Private -. "never enters" .-> ImagePrompt
```

Private data includes dice, checks, statistics, scores, targets, modifiers, trigger counters and reasons, scratchpads, parser diagnostics, rejected output, and raw reasoning. The narrative model receives only the fictional consequence required to write the scene.

Validation scans all narrative fields for mechanic leakage before display or persistence. Retrying narration reuses the durable private result rather than changing the resolved event.

Related decision: [ADR 0005](../architecture/0005-typed-private-story-orchestration.md).
