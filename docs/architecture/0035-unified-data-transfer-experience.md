# ADR 0035: Unify portable data transfer without removing specialized formats

## Status

Accepted

## Context

Infinite Quest has separate World JSON, Campaign Archive, legacy story, Infinite Worlds, CYOA, text-conversion, and readable export workflows. System Archive adds a whole-owner workflow but does not make those narrower use cases obsolete. Removing or silently converting existing formats would strand retained user files and obscure differences between portable archives and human-readable exports.

## Decision

Nexus and the replacement UI provide a shared **Data Transfer** experience organized by user purpose: System Archive, World and Campaign Archives, legacy and external imports, and Readable Story Exports. Existing contextual actions remain as shortcuts into the corresponding workflow.

The server detects and validates the exact selected file format. If it differs from the user's initial category, the UI routes to the correct Import Preview. Archive contents are not parsed in browser JavaScript; pasted content remains limited to supported text and JSON workflows.

Every currently supported import and export format remains available through an explicit Compatibility Adapter until it receives an announced deprecation period and a tested conversion path. Legacy labeling may explain reduced source guarantees, but adapters never silently discard unsupported content.

After System Import, Data Transfer presents a provider-reconfiguration checklist, invalidated external-access summary, derived-rebuild status, and the durable Import Report. It never offers automatic source synchronization or source deletion.

## Consequences

- Users gain one discoverable transfer area without losing task-specific entry points.
- Both active client surfaces consume the same server-owned archive contracts and job state.
- Server-side detection and validation keep untrusted archive parsing out of the browser.
- Compatibility fixtures and conversion warnings remain required while historical formats are supported.
