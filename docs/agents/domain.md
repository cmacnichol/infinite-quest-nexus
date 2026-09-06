# Domain Docs

This repository uses a multi-context domain-documentation layout.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repository root, if present. It points to the `CONTEXT.md` files relevant to each application, service, package, or cross-cutting domain.
- **`docs/architecture/`** for system-wide ADRs and architectural guidance.
- The relevant context’s **`CONTEXT.md`**, if present.
- The relevant context’s **`docs/adr/`**, if present, for locally scoped decisions.

If any of these files do not exist, proceed silently. Do not flag their absence or propose creating them preemptively. The domain-modeling workflow creates them when terminology or decisions are actually resolved.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── architecture/                 ← system-wide ADRs and architecture
├── apps/
│   └── <application>/
│       ├── CONTEXT.md
│       └── docs/adr/                 ← application-specific decisions
├── services/
│   └── <service>/
│       ├── CONTEXT.md
│       └── docs/adr/                 ← service-specific decisions
└── packages/
    └── <package>/
        ├── CONTEXT.md
        └── docs/adr/                 ← package-specific decisions
```

`CONTEXT-MAP.md` is the wayfinding document. It should point consumers to only the contexts relevant to their work rather than requiring every context document to be loaded.

## Use the glossary’s vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in the relevant `CONTEXT.md`.

Do not drift to synonyms that the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the term belongs to the project. If it represents a real gap, record it for the domain-modeling workflow.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.

For example:

> Contradicts ADR-0007, but may be worth reopening because…
