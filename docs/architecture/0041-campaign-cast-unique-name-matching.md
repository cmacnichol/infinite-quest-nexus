# ADR 0041: Graduated campaign cast identity matching

## Status

Accepted 2026-11-06.

## Decision

Discovery defaults to strict corroboration. An explicitly admitted `unique_name` policy may attach a model-selected campaign identity when its evidenced name or alias uniquely matches the complete campaign identity snapshot, including ignored and omitted-hint identities. A model-declined match remains reviewable. A unique world-only name may establish world provenance when no campaign identity competes. Ambiguous identities and conflicting world provenance remain reviewable. Identity matching does not validate attributes, alter aliases, or relax source and fiction checks.

The policy and trusted prompt identity are frozen with admission; old admissions decode as strict with the unchanged v1 prompt. The v2 prompt describes the relaxed matching rule, while the output protocol remains `cast-discovery-v1`. Captured policies govern publication even if configuration changes. The amended [character automation plan](../superpowers/plans/2026-11-06-characters-automation.md) supersedes conflicting implementation details in the [October plan](../superpowers/plans/2026-10-04-campaign-cast-auto-match.md).

A textual mention, an established identity, and physical presence are distinct. A mention is source-linked text, not proof of an encounter or location. A matching identity does not establish presence or authorize a new fact. Automatic attachments must retain evidence and support an explicit, durable undo; this decision does not introduce a general merge or split operation.
