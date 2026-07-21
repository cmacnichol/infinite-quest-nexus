# Deploy the Swarm stack

1. Verify external PostgreSQL, pgvector, private DNS, secrets, and shared assets.
2. Set an immutable application image:

```bash
export NEXUS_IMAGE=ghcr.io/cmacnichol/infinite-quest-nexus:VERSION
```

3. Render the stack:

```bash
docker stack config -c deploy/swarm/stack.yaml >/dev/null
```

4. Deploy:

```bash
docker stack deploy -c deploy/swarm/stack.yaml infinitequest
```

5. Inspect services and tasks:

```bash
docker stack services infinitequest
docker stack ps infinitequest
```

6. Verify API readiness, migration completion, worker database health, shared asset writes, and one database-backed management operation.

The stack does not provision TLS, PostgreSQL, backups, metrics, or the shared filesystem.
