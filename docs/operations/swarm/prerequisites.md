# Swarm prerequisites

- An initialized Docker Swarm
- A registry-accessible, immutable Nexus image tag or digest
- External PostgreSQL compatible with the repository's PostgreSQL 18/pgvector behavior
- Database DNS and routing reachable from every API and worker node
- Two pre-created external Swarm secrets
- A shared asset filesystem mounted at the same host path on every eligible node
- Trusted-network ingress and an operator-managed TLS/reverse-proxy layer

Do not use `host.docker.internal` as a Swarm database or provider address. Use stable private DNS.

Validate the manifest before deployment:

```bash
docker stack config -c deploy/swarm/stack.yaml >/dev/null
```
