# ADR 0043 — Shared campaign cast reference translation

## Status

Accepted 2026-11-14.

## Context

Branching and world transfer used recursive property-name translation for campaign cast records. Campaign Archive import translated the same references separately by command type. Each new seed or merge reference required changes in both implementations. An invalidated lexical mention could retain its historical evidence turn while its source range acquired a destination turn, preventing a later archive restore.

## Decision

The domain module `campaign-cast-references` translates typed cast events, their commands, receipts and attachments, and stored observations. Its interface accepts destination ID maps and workflow-owned origin and evidence rules. Profile content, authored edits, names and quoted text remain opaque to reference translation.

Each workflow selects retained records, allocates destination identities, handles historical evidence and world provenance, validates ownership and source relationships, and controls its transaction. The translator reports missing required mappings through the workflow's error policy. An invalidated lexical source range retains its historical turn alongside the invalidated evidence. Destination validation continues to reject inconsistent input references.

The local-copy and archive-import adapters share the translator. In-installation transfer continues to copy retained records directly, as established in [the campaign transfer decision](./0019-cross-world-campaign-transfer.md). Archive import continues to validate supported logical formats as established in [the archive contract decision](./0033-versioned-deterministic-system-archives.md).

## Consequences

Reference knowledge has locality within one implementation. Tests exercise the same interface used by both adapters, covering nested merge and seed references, observation supersession, historical evidence and literal profile data. PostgreSQL tests verify branching, world transfer and archive restore through their existing workflows. Future cast commands require an explicit translation case and associated tests.
