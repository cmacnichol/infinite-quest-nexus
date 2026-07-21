# Swarm architecture

The Swarm stack uses the same application image and runtime contract as Compose, but separates roles:

- `infinitequest-api`: replicated stateless HTTP/API and static web serving
- `infinitequest-worker`: replicated durable Story Engine, Chronicle, and image jobs
- External PostgreSQL with pgvector: authoritative state and replica coordination
- External shared filesystem: generated image assets

The stack intentionally contains no PostgreSQL service. API and worker replicas coordinate through the database; they do not depend on sticky sessions, local locks, or process memory for correctness.

The default stack creates an attachable `infinitequest-backend` overlay and publishes API port 8080 through ingress.
