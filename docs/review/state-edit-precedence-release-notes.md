# State Edit precedence release notes

Existing State Edits to location, condition, clothing, and goals immediately yield to valid Observations from a strictly later turn. The edit remains in history. Corrections to stable fields continue to apply until cleared. When an Observation is wrong, retract it; if retraction is unavailable, edit the field again to make a newer State Edit.

Enable this release only where the `observationDecisions` capability is available. Deploy readers that understand V3 before enabling V3 enqueue, and retain them while V3 jobs or turns exist. A job whose cast authority changes after capture becomes stale and needs a fresh job. Unchanged V2 jobs continue with their frozen protocol.

See [ADR 0045](../architecture/0045-current-state-edits-yield-to-newer-story-evidence.md).
