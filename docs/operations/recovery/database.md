# Recover database availability

If PostgreSQL becomes unavailable, API readiness fails and workers cannot claim or commit jobs. Restore database service before attempting provider or job recovery.

1. Stop changes at the ingress if partial availability could cause confusion.
2. Diagnose PostgreSQL storage, network, credentials, and server health.
3. Restore from the complete recovery set into an isolated environment when data recovery is required.
4. Verify migration inventory and pgvector.
5. Verify initial-user UUID and ownership constraints.
6. Verify accepted turns, campaign state, and asset references.
7. Restore the original credential-encryption key and test safe provider decryption.
8. Rebuild derived Chronicle indexes as needed.
9. Re-enable API and workers and inspect expired job leases.

Do not point the application at a partial or unreviewed restore while workers are still processing the previous database.
