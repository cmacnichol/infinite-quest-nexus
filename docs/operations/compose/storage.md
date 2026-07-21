# Compose storage

Compose names the project `infinitequest` and creates database and asset volumes. Inspect their resolved names with:

```powershell
docker volume ls --filter label=com.docker.compose.project=infinitequest
```

The application runs as a non-root container user. Named volumes are initialized through the image/engine; custom bind mounts must be writable by UID and GID 10001.

Monitor free space for both PostgreSQL and assets. Chronicle vectors and summaries are rebuildable, but accepted turns, world versions, campaign state, and referenced image files are not interchangeable.
