# Domain Docs

This repository uses a single-context domain-documentation layout: one glossary at the repository root and one ADR directory.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root: the project glossary.
- **`docs/architecture/`**: read the ADRs (`NNNN-<slug>.md`) that touch the area you are about to work in.

If any of these files do not exist, proceed silently. Do not flag their absence or propose creating them preemptively. The domain-modeling workflow creates or updates them when terminology or decisions are actually resolved.

## File structure

```text
/
├── CONTEXT.md
└── docs/
    └── architecture/
        ├── 0001-postgresql-chronicle.md
        ├── 0002-postgresql-worker-jobs.md
        └── …
```

New ADRs go in `docs/architecture/` with the next unused number. Some existing numbers are shared by two ADRs (for example, two `0011-*` files), so cite an ADR by its full filename, not just its number.

## Use the glossary's vocabulary

When output names a domain concept (in an issue title, refactor proposal, hypothesis, or test name), use the term defined in `CONTEXT.md`. Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the term belongs to the project. If it represents a real gap, record it for the domain-modeling workflow.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.

For example:

> Contradicts `0007-world-library-versioning.md`, but may be worth reopening because…
