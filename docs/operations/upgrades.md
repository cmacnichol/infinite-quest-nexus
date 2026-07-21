# Upgrade Nexus

1. Read release notes, migration changes, provider-contract changes, and rollback notes.
2. Back up PostgreSQL, generated assets, and the credential-encryption key.
3. Pin the intended application image or source revision.
4. Render and validate the deployment manifest.
5. Deploy API migration coordination before expecting workers to process the new schema.
6. Verify readiness, migration inventory, provider health, asset access, and one database-backed operation.

Online migrations should be expand/contract compatible with rolling API replicas. Maintenance migrations require explicit review and may prevent a simple image rollback.

For Compose, rebuild and restart with `docker compose up --build`. For Swarm, update `NEXUS_IMAGE` to an immutable tag or digest and follow the stack rollout policy.

Never assume reverting the application image also reverts a forward-only database migration. Document a release-specific recovery plan before deployment.
