# ADR 0033: System Archives use versioned deterministic logical contracts

## Status

Accepted

## Context

System Archives may be retained for years and imported by a different application release. Table dumps couple archives to one migration state, while a single unversioned JSON document becomes unbounded as an installation grows and makes compatibility failures difficult to diagnose.

## Decision

System Archive reuses the hardened archive container shared with Campaign Archive while retaining its distinct system scope. A deterministic ZIP contains a versioned root manifest, independently versioned logical payloads, deterministically sharded record streams, explicit asset bindings, entry byte lengths and SHA-256 hashes, an Archive Fingerprint, and content-addressed Original Assets. It never contains executable SQL or database migrations.

Every archive is untrusted input. Checksums prove entry integrity, not source authenticity or authorization. Format version 1 does not require application-managed signatures; a future detached operator signature cannot bypass schema, scope, relationship, image, or ownership validation.

Before Import Preview, the server rejects unsafe or ambiguous paths, absolute paths, backslashes, control characters, links and special files, duplicate names after Unicode normalization and case folding, undeclared or multiply declared entries, limit or expansion violations, invalid images, invalid metadata, and broken logical relationships. Nested portable metadata uses explicit field allowlists.

Compatible payload additions remain within a container major version and define explicit defaults. Breaking contract changes create a new major version. Newer applications import supported older versions through explicit logical adapters; older applications reject unsupported newer archives with a typed compatibility error. A published format version is not retired without a standalone conversion path.

## Consequences

- Archive compatibility is an external product contract independent of the live table layout.
- Deterministic content supports integrity verification, reproducible fixtures, and idempotent job handling.
- Large installations can stream bounded record shards rather than materializing one unbounded document.
- Schema evolution requires maintained logical adapters and compatibility tests.
