# Documentation style guide

## Purpose

Documentation is part of the Infinite Quest Nexus product. Keep it accurate, reviewable with the code it describes, safe to follow, and clear about the difference between current behavior and future plans.

## Product language

- Use **Infinite Quest Nexus** for the platform and management experience.
- Use **Infinite Quest** for the player-facing story experience.
- Use **World Library**, **Campaigns**, **Chronicle**, and **Story Engine** as named product domains.
- A **world** is an editable authored project.
- A **world version** is an immutable published snapshot.
- A **campaign** is a mutable story instance created from one world version.
- A **turn** is append-only after acceptance.
- **Campaign state** is authoritative mutable state produced by accepted turns.
- **Derived memory** includes summaries and embeddings that can be rebuilt.
- Call the external story service a **text provider** or **text endpoint**. Do not use LM Studio as a synonym for every supported provider.
- Treat text, embedding, and image providers as independent roles with independent URLs, credentials, models, health, and retry behavior.

## Page intent

Give each page one dominant purpose:

- A tutorial teaches by guiding a complete learning journey.
- A how-to guide helps a capable reader complete a specific task.
- Reference states accurate facts without turning them into a walkthrough.
- Explanation builds understanding and links to procedures rather than duplicating them.

Use task-oriented titles for procedures, such as **Back up a Compose deployment**. Use noun titles for reference, such as **Environment variables**.

## Voice and structure

- Address the reader directly when giving instructions.
- Lead with the result or prerequisite that matters most.
- Use short paragraphs and descriptive headings.
- Use numbered steps only when order matters.
- State the expected result after a significant command or UI action.
- Link to background explanation instead of interrupting a procedure with it.
- Prefer exact UI labels in bold.
- Prefer exact commands and configuration names in code formatting.
- Define an abbreviation on first use.
- Avoid claims such as “simple,” “obvious,” or “just.”

## Current, planned, and historical behavior

- Active documentation describes behavior present in the current repository.
- Mark unreleased or experimental behavior explicitly.
- Put proposals in issues or ADR proposals, not in operational instructions.
- Put completed milestone reports under Project History.
- Never let a checkpoint or deferred-work document become the sole source for a current procedure.

## Commands and safety

- Test commands against the current repository or deployment mode.
- Identify the shell when syntax is platform-specific.
- Explain required working directories and prerequisites.
- Put destructive commands in a warning immediately before the command.
- State exactly what data a destructive command affects and whether it can be recovered.
- Distinguish `docker compose down` from `docker compose down --volumes`.
- Never use a real credential, private host, private campaign, or production identifier in an example.
- Use obvious placeholders such as `replace-with-a-long-random-value`.

## Security and privacy

- Do not publish database passwords, provider keys, exported private campaigns, hidden trackers, raw model responses, or private reasoning.
- State that pre-authentication deployments must be limited to the intended trusted network.
- Do not suggest caller-supplied `user_id` values as proof of identity.
- Explain that imports belong to the server-resolved initial user during the pre-authentication phase.
- Treat imported files, Markdown, generated HTML, and model output as untrusted input.
- Never show text-provider credentials in an image-provider example, or the reverse.

## Screenshots and diagrams

- Use sanitized fictional content created for documentation.
- Crop to the relevant region while retaining enough context to locate the control.
- Capture at a consistent viewport and theme.
- Provide useful alternative text and a caption that explains the outcome.
- Do not rely on color alone to communicate status.
- Prefer Mermaid for relationships and workflows that are easier to maintain as text.
- Verify every diagram against the current implementation and link architectural claims to ADRs.

## Links and ownership

- Use relative links between documentation pages.
- Link to the most specific authoritative page rather than a section that duplicates it.
- Keep links to code stable where possible; avoid line-number links in published documentation.
- Add or update documentation in the same pull request as user-visible behavior, configuration, API, schema, deployment, or security changes.
- Assign a reviewer familiar with the affected domain.
## Page metadata

Use frontmatter only when it provides value. Supported fields should remain limited and consistent:

```yaml
---
title: Configure a text provider
description: Connect Infinite Quest Nexus to a supported story text endpoint.
lastUpdated: true
---
```

Use visible notices for Experimental, Administrator-only, Swarm-only, Legacy, Security-sensitive, or Planned content. Do not badge ordinary stable pages.
