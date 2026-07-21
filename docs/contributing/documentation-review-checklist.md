# Documentation review checklist

Use the applicable items when reviewing a documentation change.

## Accuracy

- [ ] The page describes behavior present in the current code or is clearly marked otherwise.
- [ ] UI labels match the current interface.
- [ ] Commands and configuration examples were tested.
- [ ] Links point to the authoritative page.
- [ ] Compose and Swarm behavior are not conflated.
- [ ] Text, embedding, and image provider roles remain independent.
- [ ] World, world-version, campaign, turn, and memory terminology is correct.

## User outcome

- [ ] The intended audience and prerequisite knowledge are clear.
- [ ] A procedure states its expected result.
- [ ] Failure recovery or troubleshooting is linked where needed.
- [ ] Conceptual explanation does not obscure the task steps.
- [ ] Reference material is factual and complete enough to consult during work.

## Safety

- [ ] Examples contain no credentials, private hosts, personal data, or private story content.
- [ ] Destructive commands identify the affected data and recovery implications.
- [ ] Trusted-network requirements are present where authentication limitations matter.
- [ ] Mechanics, private reasoning, and hidden state are never presented as narration or Chronicle content.
- [ ] Import and rendering examples treat input as untrusted.

## Presentation

- [ ] Headings are descriptive and ordered correctly.
- [ ] Code blocks identify the language or shell.
- [ ] Images have useful alternative text and sanitized content.
- [ ] Diagrams remain readable in light, dark, desktop, and mobile contexts.
- [ ] The page is discoverable through navigation, search, or an intentional cross-link.

## Change integration

- [ ] User-visible changes include corresponding guide updates.
- [ ] API or schema changes include reference updates.
- [ ] Configuration changes include default, secret, role, and restart information.
- [ ] Deployment changes include upgrade and rollback implications.
- [ ] Meaningful architecture changes include or update an ADR.
- [ ] Removed or moved content has an appropriate replacement link.
