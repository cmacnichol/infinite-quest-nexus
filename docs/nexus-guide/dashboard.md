# Nexus dashboard

The Nexus dashboard is the landing page for Infinite Quest Nexus. It brings together a high-level activity summary, available worlds, and the current user's campaigns without replacing the full management workspaces.

## Activity summary

The stats area provides an at-a-glance view of the library and recent play, including:

- Available worlds
- Open campaigns
- Total accepted turns generated
- Provider-reported API fees, grouped by text, image, or memory work and provider when cost data is available

Additional activity indicators may appear alongside these core totals. Provider fees include only costs reported by providers; Nexus does not estimate missing prices or usage.

## Browse available worlds

Use the world search to narrow the horizontal carousel by title or description. Each world card summarizes the world and displays a generated world cover when one is available; otherwise it shows a themed placeholder. World-cover generation is managed from **Setup → World Management** and uses the default image provider.

Select a card to open **World Details**. The details view presents the world's published information and offers two paths:

- **Edit world** opens **Setup → World Management** for authoring, publishing, version history, and other administrative work.
- **Create campaign** opens the basic campaign form for a campaign name and playable-character selection. Other settings use the current system defaults.

Choose **Advanced creation** from the basic form to open **Setup → Campaign Management** when you need provider, response-length, turn-control, or other campaign settings. Completing the basic form creates the campaign, opens its Story page, and starts the world's first turn immediately.

Campaign creation still requires an eligible published world version and a complete playable-character roster. The selected world version and character are snapshotted into the new campaign.

## Resume a campaign

Use campaign search to narrow the campaign carousel. Campaign cards summarize each campaign and reserve a place for campaign artwork. Select a campaign card to resume it at the latest accepted scene. If that campaign has a durable generation in progress, the Story page reconnects to it.

Use **Setup → Campaign Management** for configuration, version upgrades, archive and deletion, Chronicle controls, and illustration settings. The dashboard is intentionally focused on discovery, quick creation, and resume.

## Universal navigation

The slim navigation bar remains available on the dashboard, Story page, and management pages. The themed Infinite Quest Nexus logo returns to the dashboard.

**Dashboard** and **Story** are grouped together before a divider because they switch between the two primary application experiences. Setup and other context-specific controls follow the divider. Open controls use a highlighted state instead of a caret indicator.

- **Dashboard** opens the Nexus landing page.
- **Story** opens the active campaign, or the empty Story page when no campaign is active.
- **Setup** groups World Management, Campaign Management, Providers, Import, Chronicle, and related configuration.
- **Export** appears only in the Story view and offers readable Markdown or print-to-PDF output. Available scene illustrations are included.
- **About** opens application and release information.

The active destination is highlighted. On narrow screens, the same destinations remain available in the responsive bar.
