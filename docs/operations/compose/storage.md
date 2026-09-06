# Compose storage

Compose names the project `infinitequest` and creates database, asset, archive, and encryption-key volumes; see the [complete storage layout](../../installation/storage.md). Inspect their resolved names with:

```powershell
docker volume ls --filter label=com.docker.compose.project=infinitequest
```

The application runs as a non-root container user. Named volumes are initialized through the image/engine; custom bind mounts must be writable by UID and GID 10001.

Monitor free space for PostgreSQL, assets, and archive staging/downloads. Preserve the generated credential-encryption key separately; removing its volume can make retained encrypted provider credentials unreadable. Chronicle vectors and summaries are rebuildable, but accepted turns, world versions, campaign state, and referenced image files are not interchangeable.
