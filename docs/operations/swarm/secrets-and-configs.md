# Swarm secrets and configuration

The stack expects these external secrets:

- `infinitequest_database_url`
- `infinitequest_credential_encryption_key`

Create them through an operator-approved secret-input process that does not expose values in shell history. The database URL must use private DNS and TLS parameters appropriate to the database service. Preserve the encryption key in the recovery set.

The runtime reads secrets from `/run/secrets/` through `DATABASE_URL_FILE` and `CREDENTIAL_ENCRYPTION_KEY_FILE`. File values are trimmed; a directly supplied environment value would take precedence.

Non-sensitive deployment values include `NEXUS_IMAGE` and `NEXUS_PORT`. Pin `NEXUS_IMAGE` to an immutable release tag or digest instead of relying on `latest` for controlled upgrades.

Rotating the database password requires a new secret and coordinated database change. Replacing the credential-encryption key without re-encrypting stored provider credentials makes them unreadable.
