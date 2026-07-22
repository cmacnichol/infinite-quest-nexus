# ADR 0020: Retire the legacy player from the runtime

## Status

Accepted

## Context

ADR 0004 introduced a temporary bridge so the original root `index.html` player could submit durable Story Engine jobs while the replacement player was built. The active player now lives under `apps/web/public`, uses database-authoritative campaigns and turns, and routes provider operations through the Nexus API and worker.

The root legacy file nevertheless remained in the production image and was served at `/` and `/index.html`. That made its browser-owned saves, browser-held provider credentials, direct-provider requests, duplicate story functions, and client-side diagnostics reachable even though current documentation described the file as historical reference only. Tests and runtime configuration also continued to make the legacy client look supported.

## Decision

The Nexus management application at `/nexus/` and the Story Player at `/story/:campaignId` are the only active browser clients. Requests for `/` and `/index.html` redirect to `/nexus/` and never read or return the root legacy file.

The application image, runtime configuration, environment contract, and active tests do not include or depend on root `index.html`. The file may remain unchanged in the repository as historical source, but it is not an executable application artifact and receives no feature-parity maintenance.

Explicit compatibility boundaries remain supported. Nexus may detect an original browser save and offer an explicit import, and the API retains validated portable legacy import contracts, conversions, migrations, and regression fixtures. Compatibility data is assigned to the server-resolved owner and becomes authoritative only after database import.

Active browser code must use same-origin Nexus API routes for provider and authoritative state operations. Repository checks reject active console writes, executable legacy-client references, and direct browser provider calls outside reviewed compatibility boundaries.

## Consequences

- ADR 0004 remains the record of the migration bridge but no longer describes current runtime routing.
- A root URL consistently enters World Library and Campaign management instead of exposing two competing players.
- Provider credentials and authoritative story state cannot fall back to the historical browser implementation.
- Legacy portable files and browser saves remain importable without retaining the legacy runtime.
- Tests target the active management application, Story Player, API, and domain contracts.
- Historical source can contain obsolete implementation details because it is excluded from runtime artifacts and active-code enforcement.
