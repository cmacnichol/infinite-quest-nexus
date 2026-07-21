import { defineConfig } from "vitepress";

const repositoryName = "infinite-quest-nexus";
const repositoryUrl = "https://github.com/cmacnichol/infinite-quest-nexus";
const configuredBase = process.env.DOCS_BASE?.trim();
const base = configuredBase === "/"
  ? "/"
  : configuredBase
    ? `/${configuredBase.replace(/^\/+|\/+$/g, "")}/`
    : `/${repositoryName}/`;
const siteUrl = process.env.DOCS_SITE_URL ?? "https://cmacnichol.github.io/infinite-quest-nexus/";

export default defineConfig({
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
      { text: "Getting Started", link: "/getting-started/overview" },
      { text: "Player Guide", link: "/player-guide/" },
      { text: "Architecture", link: "/architecture/" },
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
  }
});
