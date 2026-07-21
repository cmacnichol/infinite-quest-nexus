import { withMermaid } from "vitepress-plugin-mermaid";

const repositoryName = "infinite-quest-nexus";
const repositoryUrl = "https://github.com/cmacnichol/infinite-quest-nexus";
const configuredBase = process.env.DOCS_BASE?.trim();
const base = configuredBase === "/"
  ? "/"
  : configuredBase
    ? `/${configuredBase.replace(/^\/+|\/+$/g, "")}/`
    : `/${repositoryName}/`;
const siteUrl = process.env.DOCS_SITE_URL ?? "https://cmacnichol.github.io/infinite-quest-nexus/";

export default withMermaid({
  title: "Infinite Quest Nexus",
  description: "Create reusable story worlds and run persistent AI-assisted campaigns.",
  lang: "en-US",
  base,
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: siteUrl
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
    ["meta", { name: "theme-color", content: "#6d5dfc" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Infinite Quest Nexus documentation" }],
    [
      "meta",
      {
        property: "og:description",
        content: "Guides for playing, authoring worlds, deploying, and contributing to Infinite Quest Nexus."
      }
    ]
  ],
  themeConfig: {
    logo: "/favicon.svg",
    siteTitle: "Infinite Quest Nexus",
    nav: [
      { text: "Home", link: "/" },
      {
        text: "Guides",
        items: [
          { text: "Getting Started", link: "/getting-started/overview" },
          { text: "Player Guide", link: "/player-guide/" },
          { text: "Nexus Guide", link: "/nexus-guide/" }
        ]
      },
      {
        text: "Deploy and operate",
        items: [
          { text: "Installation", link: "/installation/" },
          { text: "Operations", link: "/operations/" }
        ]
      },
      {
        text: "Architecture",
        items: [
          { text: "Concepts", link: "/concepts/" },
          { text: "Decision records", link: "/architecture/" }
        ]
      },
      { text: "Capabilities", link: "/reference/capabilities" }
    ],
    sidebar: {
      "/getting-started/": [
        {
          text: "Getting Started",
          items: [
            { text: "Platform overview", link: "/getting-started/overview" },
            { text: "Quick start", link: "/getting-started/quick-start" },
            { text: "Create your first world", link: "/getting-started/first-world" },
            { text: "Create your first campaign", link: "/getting-started/first-campaign" },
            { text: "Generate your first turn", link: "/getting-started/first-story-turn" }
          ]
        }
      ],
      "/player-guide/": [
        {
          text: "Player Guide",
          items: [
            { text: "Overview", link: "/player-guide/" },
            { text: "Player interface", link: "/player-guide/interface" },
            { text: "Start or resume", link: "/player-guide/starting-a-story" },
            { text: "Actions and choices", link: "/player-guide/actions-and-choices" },
            { text: "Characters and statistics", link: "/player-guide/characters-and-stats" },
            { text: "Story response length", link: "/player-guide/story-length" },
            { text: "Switch text models", link: "/player-guide/switching-models" },
            { text: "Continuity and history", link: "/player-guide/campaign-continuity" },
            { text: "Illustrations", link: "/player-guide/illustrations" },
            { text: "Save and export", link: "/player-guide/saving-and-exporting" },
            { text: "Recover a generation", link: "/player-guide/recovering-a-generation" },
            { text: "Troubleshooting", link: "/player-guide/troubleshooting" }
          ]
        }
      ],
      "/nexus-guide/": [
        {
          text: "Nexus Guide",
          items: [
            { text: "Overview", link: "/nexus-guide/" },
            { text: "Navigate Nexus", link: "/nexus-guide/navigating-nexus" }
          ]
        },
        {
          text: "World Library",
          collapsed: false,
          items: [
            { text: "Create a world", link: "/nexus-guide/worlds/create" },
            { text: "Edit drafts", link: "/nexus-guide/worlds/edit-drafts" },
            { text: "Playable characters", link: "/nexus-guide/worlds/characters" },
            { text: "Publish a version", link: "/nexus-guide/worlds/publish" },
            { text: "Version history", link: "/nexus-guide/worlds/version-history" },
            { text: "Fork a version", link: "/nexus-guide/worlds/fork" },
            { text: "Archive and restore", link: "/nexus-guide/worlds/archive-restore" },
            { text: "Delete worlds or versions", link: "/nexus-guide/worlds/delete" },
            { text: "Import and export", link: "/nexus-guide/worlds/import-export" }
          ]
        },
        {
          text: "Campaigns",
          collapsed: false,
          items: [
            { text: "Create a campaign", link: "/nexus-guide/campaigns/create" },
            { text: "Select and load", link: "/nexus-guide/campaigns/select-and-load" },
            { text: "Configure", link: "/nexus-guide/campaigns/configure" },
            { text: "Upgrade world version", link: "/nexus-guide/campaigns/upgrade-world-version" },
            { text: "Archive or delete", link: "/nexus-guide/campaigns/archive-delete" },
            { text: "Import and export", link: "/nexus-guide/campaigns/import-export" }
          ]
        },
        {
          text: "Chronicle",
          collapsed: true,
          items: [
            { text: "Inspect health", link: "/nexus-guide/chronicle/inspect" },
            { text: "Context preview", link: "/nexus-guide/chronicle/context-preview" },
            { text: "Retrieval modes", link: "/nexus-guide/chronicle/retrieval-modes" },
            { text: "Rebuild memory", link: "/nexus-guide/chronicle/reindex" },
            { text: "Embeddings", link: "/nexus-guide/chronicle/embeddings" }
          ]
        },
        {
          text: "Providers",
          collapsed: true,
          items: [
            { text: "Story text", link: "/nexus-guide/providers/text" },
            { text: "Embeddings", link: "/nexus-guide/providers/embeddings" },
            { text: "Images", link: "/nexus-guide/providers/images" },
            { text: "Model discovery", link: "/nexus-guide/providers/model-discovery" },
            { text: "Health and errors", link: "/nexus-guide/providers/health-and-errors" }
          ]
        }
      ],
      "/installation/": [
        {
          text: "Installation",
          items: [
            { text: "Choose a deployment", link: "/installation/" },
            { text: "Requirements", link: "/installation/requirements" },
            { text: "Docker Compose", link: "/installation/docker-compose" },
            { text: "Runtime configuration", link: "/installation/environment-configuration" },
            { text: "Provider connectivity", link: "/installation/provider-configuration" },
            { text: "Verify installation", link: "/installation/verify-installation" },
            { text: "Initial user", link: "/installation/initial-user" },
            { text: "Storage", link: "/installation/storage" },
            { text: "Network access", link: "/installation/network-access" }
          ]
        }
      ],
      "/operations/": [
        {
          text: "Operations",
          items: [
            { text: "Overview", link: "/operations/" },
            { text: "Health and readiness", link: "/operations/health-readiness" },
            { text: "Logs and correlation", link: "/operations/logs-and-correlation" },
            { text: "Migrations", link: "/operations/migrations" },
            { text: "Upgrades", link: "/operations/upgrades" },
            { text: "Backup and restore", link: "/operations/backup-restore" },
            { text: "Troubleshooting", link: "/operations/troubleshooting" },
            { text: "Security", link: "/operations/security" }
          ]
        },
        {
          text: "Compose",
          collapsed: true,
          items: [
            { text: "Lifecycle", link: "/operations/compose/lifecycle" },
            { text: "Storage", link: "/operations/compose/storage" },
            { text: "Reset", link: "/operations/compose/reset" }
          ]
        },
        {
          text: "Swarm",
          collapsed: true,
          items: [
            { text: "Architecture", link: "/operations/swarm/architecture" },
            { text: "Prerequisites", link: "/operations/swarm/prerequisites" },
            { text: "Secrets and configuration", link: "/operations/swarm/secrets-and-configs" },
            { text: "Deploy", link: "/operations/swarm/deploy" },
            { text: "Upgrade and rollback", link: "/operations/swarm/upgrade-rollback" },
            { text: "Scaling", link: "/operations/swarm/scaling" },
            { text: "Shared assets", link: "/operations/swarm/shared-assets" },
            { text: "External PostgreSQL", link: "/operations/swarm/external-postgresql" }
          ]
        },
        {
          text: "Recovery",
          collapsed: true,
          items: [
            { text: "Generation jobs", link: "/operations/recovery/generation-jobs" },
            { text: "Image jobs", link: "/operations/recovery/image-jobs" },
            { text: "Chronicle indexing", link: "/operations/recovery/chronicle-indexing" },
            { text: "Database", link: "/operations/recovery/database" }
          ]
        }
      ],
      "/concepts/": [
        {
          text: "Concepts",
          items: [
            { text: "Overview", link: "/concepts/" },
            { text: "Platform overview", link: "/concepts/platform-overview" },
            { text: "Worlds and versions", link: "/concepts/worlds-and-versions" },
            { text: "Campaigns and turns", link: "/concepts/campaigns-and-turns" },
            { text: "Authoritative state", link: "/concepts/authoritative-state" },
            { text: "Chronicle memory", link: "/concepts/chronicle-memory" },
            { text: "Context construction", link: "/concepts/context-construction" },
            { text: "Story Engine", link: "/concepts/story-engine" },
            { text: "Generation integrity", link: "/concepts/generation-integrity" },
            { text: "Mechanics and fiction", link: "/concepts/mechanics-and-fiction-separation" },
            { text: "Illustration pipeline", link: "/concepts/illustration-pipeline" },
            { text: "Provider model", link: "/concepts/provider-model" },
            { text: "Identity and ownership", link: "/concepts/identity-and-ownership" },
            { text: "Security boundaries", link: "/concepts/security-boundaries" }
          ]
        }
      ],
      "/architecture/": [
        {
          text: "Architecture decisions",
          items: [
            { text: "Decision index", link: "/architecture/" },
            { text: "PostgreSQL Chronicle", link: "/architecture/0001-postgresql-chronicle" },
            { text: "Durable worker jobs", link: "/architecture/0002-postgresql-worker-jobs" },
            { text: "Story Engine ownership", link: "/architecture/0003-worker-owned-story-engine" },
            { text: "Player bridge", link: "/architecture/0004-player-story-engine-bridge" },
            { text: "Private orchestration", link: "/architecture/0005-typed-private-story-orchestration" },
            { text: "Semantic Chronicle", link: "/architecture/0006-campaign-scoped-semantic-chronicle" },
            { text: "World Library versioning", link: "/architecture/0007-world-library-versioning" },
            { text: "Illustration pipeline", link: "/architecture/0008-independent-illustration-pipeline" },
            { text: "Schema migrations", link: "/architecture/0009-automatic-schema-migrations" },
            { text: "Dynamic Chronicle", link: "/architecture/0010-dynamic-chronicle-context" },
            { text: "Provider costs", link: "/architecture/0011-provider-reported-campaign-costs" },
            { text: "Transport deadlines", link: "/architecture/0012-provider-transport-deadlines" },
            { text: "Character rosters", link: "/architecture/0013-playable-character-rosters" },
            { text: "Roster-only guidance", link: "/architecture/0014-roster-only-world-character-guidance" },
            { text: "World-version deletion", link: "/architecture/0015-deletable-unused-world-versions" },
            { text: "Reviewed character authoring", link: "/architecture/0016-reviewed-character-authoring" }
          ]
        }
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [{ text: "Current capabilities", link: "/reference/capabilities" }]
        }
      ],
      "/project-history/": [
        {
          text: "Project history",
          items: [{ text: "Checkpoints and planning", link: "/project-history/" }]
        }
      ],
      "/contributing/": [
        {
          text: "Documentation contributors",
          items: [
            { text: "Style guide", link: "/contributing/documentation-style-guide" },
            { text: "Review checklist", link: "/contributing/documentation-review-checklist" },
            { text: "Visual assets", link: "/contributing/visual-assets-plan" }
          ]
        }
      ]
    },
    search: {
      provider: "local",
      options: {
        detailedView: true
      }
    },
    socialLinks: [{ icon: "github", link: repositoryUrl }],
    editLink: {
      pattern: `${repositoryUrl}/edit/main/docs/:path`,
      text: "Edit this page on GitHub"
    },
    footer: {
      message: "Infinite Quest Nexus documentation",
      copyright: "Documentation is maintained with the application source."
    },
    outline: {
      level: [2, 3]
    }
  },
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark"
    },
    lineNumbers: true
  },
  mermaid: {
    securityLevel: "strict",
    theme: "neutral"
  }
});
