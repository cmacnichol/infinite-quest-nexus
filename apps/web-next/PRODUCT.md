# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Creative-fiction and RPG story readers who enjoy guiding an AI-assisted story through turn-based prompts.

## Product Purpose

Infinite Quest Nexus is a self-hosted platform for creating reusable, versioned story worlds and running persistent AI-assisted campaigns. The replacement web app begins with World Management, enabling readers to prepare the worlds that support their stories.

## Positioning

The platform keeps reusable worlds, their versions, and campaigns as durable records rather than relying on a single browser session or model context window.

## Operating Context

Users manage worlds before using them in AI-assisted, turn-based fiction and RPG campaigns. They can import worlds and campaigns, and export campaigns and stories as portable records.

## Capabilities and Constraints

- The first replacement-app scope is World Management.
- World import and campaign import are required workflows.
- Campaign and story export are required workflows.
- Product terminology that must be preserved: Infinite Quest Nexus, Infinite Quest, World Library, Campaigns, Chronicle, and Story Engine.

## Evidence on Hand

- Current product capabilities: `../../docs/reference/capabilities.md`
- Architecture and domain terminology: `../../docs/architecture/repository-overview.md`
- Existing replacement-app scaffold: `src/bootstrap.ts`

## Product Principles

- Preserve authored worlds and campaign history as durable, portable user records.
- Let readers guide stories through clear turn-based interaction.
- Keep reusable world creation and management distinct from individual campaigns.
- Make import and export explicit, trustworthy user-controlled workflows.
