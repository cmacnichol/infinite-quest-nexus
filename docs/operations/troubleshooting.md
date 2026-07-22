# Troubleshoot operations

## Application never becomes ready

- Check PostgreSQL health and connection credentials.
- Confirm the `vector` extension is installed.
- Inspect migration logs for pending maintenance work or checksum/order problems.
- Confirm the database is reachable from the container network.

## Worker is healthy but jobs do not complete

- Inspect job status, lease age, attempts, and correlation IDs.
- Confirm worker schema verification completed.
- Test the selected role-specific provider from the worker network.
- Confirm model availability and request deadline.
- Verify shared asset writability for image jobs.

## Embeddings fail

Story generation should continue with lexical fallback. Confirm the embedding profile, model capability, prefixes, and batch size, then reindex.

## Images fail

Accepted story turns remain valid. Confirm independent image credentials, model, output format, shared storage permissions, and retry policy. For Sogni, also check account balance or entitlement, active-workflow and rate limits, persisted remote-job state, request timeout, generation deadline, artifact-host restrictions, and whether the chosen workflow honors the requested sensitive-content filter mode. If discovery is empty, try the exact image model ID manually.

## Saved provider key cannot be decrypted

Confirm the deployment has the same credential-encryption key used when the profile was saved. Changing the key is not a credential-rotation procedure; it makes existing ciphertext unreadable.
