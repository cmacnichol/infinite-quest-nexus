# Security posture

Infinite Quest Nexus is currently a pre-authentication single-user service. The server resolves requests to `initial-owner`; this is not proof that a caller is that owner.

## Required operator controls

- Restrict browser, API, database, and provider access to the intended trusted network.
- Add operator-managed TLS and reverse-proxy controls for remote access.
- Use separate database, encryption, text, embedding, and image secrets.
- Back up the credential-encryption key outside PostgreSQL and assets.
- Limit CORS to reviewed origins where the manifest injects that setting.
- Keep PostgreSQL unpublished unless temporary trusted development access is required.
- Treat imported worlds, exports, model output, Markdown, HTML, and assets as untrusted input.

The current CSP is permissive for provider and image connectivity, and an HSTS header does not create TLS by itself. Do not describe the browser perimeter as hardened without an external security review.

Never place credentials in URLs, screenshots, logs, issue reports, image prompts, exports, or source control.
