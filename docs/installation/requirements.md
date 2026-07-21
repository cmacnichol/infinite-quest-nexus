# Requirements

## Docker Compose

- Docker Desktop or Docker Engine with the Compose plugin
- Linux containers
- At least 2 GB available memory
- Host port 8080 by default
- Network reachability from `infinitequest-app` to the selected external providers

The included database image is `pgvector/pgvector:0.8.5-pg18-trixie`, providing PostgreSQL 18 and pgvector.

## Source workflows

- Node.js 22.13 or newer; the container and CI use Node.js 24
- pnpm 11.14.0
- A PostgreSQL/pgvector test database for integration tests

## Story providers

Nexus starts without a provider, but story generation requires a reachable compatible text endpoint. Embedding and image endpoints are optional and independently configured.

## Trust boundary

Interactive authentication is not implemented. Restrict all deployment modes to the intended trusted network and place appropriate TLS/reverse-proxy controls in front of remotely accessed installations.
