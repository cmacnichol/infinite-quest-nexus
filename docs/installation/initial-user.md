# Initial user and ownership

The first migration idempotently creates one credential-free user with system key `initial-owner`. PostgreSQL generates and retains its internal UUID.

Until authentication is implemented:

- Every request resolves to that user on the server.
- Created, generated, and imported content belongs to that user.
- Browser headers, query parameters, and request fields do not establish another identity.
- Portable source-system user identifiers are provenance only.

This preserves stable ownership for future authentication migration but does not authenticate callers. Restrict the service to the intended trusted network.

Future OIDC support must explicitly link an `(issuer, subject)` identity to the existing internal UUID. It must not assign legacy content to whichever account logs in first.
