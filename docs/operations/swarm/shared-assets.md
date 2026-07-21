# Provide shared asset storage

Both API and worker services bind mount:

```text
/srv/docker/appdata/infinite-quest-nexus/assets
  -> /var/lib/infinitequest/assets
```

The host path must be the same shared filesystem on every eligible node. The repository example assumes an externally managed CephFS-style mount but does not provision or verify it.

Requirements:

- The path exists before tasks start.
- Every eligible node sees the same files.
- UID/GID 10001 can create, read, and replace asset files safely.
- Backups are coordinated with PostgreSQL references.
- Capacity and inode usage are monitored.

A node-local directory at that path would split assets across replicas and can make accepted-turn illustrations disappear depending on which API task serves a request.
