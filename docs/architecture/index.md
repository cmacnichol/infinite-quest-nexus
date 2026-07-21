# Architecture decisions

Architecture decision records (ADRs) preserve consequential design decisions and their tradeoffs. Later decisions may refine earlier context; the product guides synthesize the current behavior while retaining this history.

Start with these foundational decisions:

- [PostgreSQL owns campaigns and Chronicle memory](./0001-postgresql-chronicle.md)
- [PostgreSQL provides the initial durable worker queue](./0002-postgresql-worker-jobs.md)
- [The worker owns text generation](./0003-worker-owned-story-engine.md)
- [World Library versioning](./0007-world-library-versioning.md)
- [Independent illustration pipeline](./0008-independent-illustration-pipeline.md)
- [Automatic coordinated schema migrations](./0009-automatic-schema-migrations.md)

The complete, categorized decision index is added during the existing-document refactoring phase.
