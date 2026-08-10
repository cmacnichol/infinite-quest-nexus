# Provide shared asset storage

Both API and worker services bind mount:

```text
/srv/docker/appdata/infinite-quest-nexus/assets
  -> /var/lib/infinitequest/assets
/srv/docker/appdata/infinite-quest-nexus/archives
  -> /var/lib/infinitequest/archives
```

The host path must be the same shared filesystem on every eligible node. The repository example assumes an externally managed CephFS-style mount but does not provision or verify it.

Requirements:

- The path exists before tasks start.
- Every eligible node sees the same files.
- UID/GID 10001 can create, read, and replace asset files safely.
- Backups are coordinated with PostgreSQL references.
- Capacity and inode usage are monitored.

A node-local directory at either path would split durable files across replicas.
That can make accepted-turn illustrations disappear depending on which API task
serves a request, or make an archive preview/import fail when its follow-up
request or cleanup claim lands on another task.
