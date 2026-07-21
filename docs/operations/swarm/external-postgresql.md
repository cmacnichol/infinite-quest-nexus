# Configure external PostgreSQL

Swarm requires an existing PostgreSQL service reachable from every node through stable private DNS.

The database must:

- Match the supported PostgreSQL major behavior used by local Compose
- Provide the `vector` extension
- Permit the configured application user to migrate and operate the Nexus schema
- Support the transaction, advisory-lock, and isolation behavior used by jobs and migrations
- Have independent backups and tested restoration
- Enforce network and TLS controls appropriate to the environment

Size connection capacity for all API and worker pools plus migrations and operator access. The application defaults to 12 connections for each API/all process and 8 for each worker process unless the deployed manifest passes another bounded value.

Do not publish the database broadly or store its URL in the stack file. Supply it through the external Swarm secret.
