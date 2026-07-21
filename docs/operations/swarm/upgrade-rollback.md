# Upgrade or roll back Swarm

## Upgrade

1. Back up PostgreSQL, assets, and the encryption key.
2. Review migration and backward-compatibility notes.
3. Set `NEXUS_IMAGE` to the new immutable tag or digest.
4. Render the stack and deploy it again.
5. Monitor API migration coordination and worker schema waits.

API updates use `start-first`, one task at a time, and roll back on monitored failure. Worker updates use `stop-first` so two worker versions do not process jobs concurrently during replacement.

## Rollback

Swarm can roll a service back to its previous image/configuration, but it cannot reverse a forward-only database migration. Confirm schema compatibility before invoking rollback.

```bash
docker service rollback infinitequest_infinitequest-api
docker service rollback infinitequest_infinitequest-worker
```

Use exact service names from `docker stack services infinitequest`. Validate readiness, job processing, and asset access after rollback.
