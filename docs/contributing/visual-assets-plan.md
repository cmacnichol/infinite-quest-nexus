# Documentation visual-assets plan

## Screenshot standard

Store documentation images under `docs/public/images/` using lowercase descriptive names. Use a consistent desktop viewport for management screens and a consistent narrow viewport for explicitly responsive examples. Capture sanitized data created only for documentation.

Each screenshot requires:

- A source page owner
- A scenario describing how to reproduce it
- Meaningful alternative text
- A short caption describing the relevant outcome
- Review when the associated UI changes

## Initial screenshot set

| Filename | Subject | Used by |
| --- | --- | --- |
| `nexus-home.png` | Nexus management landing page | Getting Started, Nexus Guide |
| `text-provider-profile.png` | Text provider form with safe placeholders | Quick Start, Providers |
| `model-discovery.png` | Discovered model selection | Quick Start, Providers |
| `world-library.png` | World list and selected draft | First World, World Library |
| `world-editor.png` | Premise, canon, and structured authoring controls | First World |
| `character-review.png` | Reviewed character authoring dialog | World characters |
| `publish-world-version.png` | Publication confirmation | First World, Versioning |
| `campaign-create.png` | Campaign creation from a published version | First Campaign |
| `campaign-selected.png` | Selected campaign management panel | Campaigns |
| `load-story.png` | Load-story handoff control | First Campaign, Player Guide |
| `player-provider-context.png` | Database-backed Story Engine controls | First Turn |
| `player-action.png` | Player action input | First Turn, Player Guide |
| `generation-progress.png` | Durable generation status | First Turn, Recovery |
| `accepted-turn.png` | Completed narration and choices | Player Guide |
| `illustration-config.png` | Independent image provider configuration | Illustrations |
| `chronicle-inspector.png` | Chronicle metrics and context preview | Chronicle Guide |
| `portable-export.png` | World or campaign export controls | Import and Export |

Screenshots are not a prerequisite for publishing an accurate first text release. A missing image must not block a user from completing a documented task.

## Diagram set

Maintain these as Mermaid source in the relevant concept pages:

- System context and provider boundaries
- World draft to immutable version to campaign relationship
- Authoritative state versus derived Chronicle indexes
- Durable generation state machine
- Prompt scopes
- Illustration child-job isolation
- Initial-user and future OIDC identity mapping
- Compose and Swarm deployment topologies

## Sanitization checklist

- No provider API keys or credential headers
- No database passwords or connection strings containing secrets
- No private DNS names, external IP addresses, or personal filesystem paths
- No real campaign exports or user-authored private lore
- No browser autofill values or account identifiers
- No raw model response, private reasoning, roll details, or hidden trackers
- No image metadata that reveals sensitive local information
