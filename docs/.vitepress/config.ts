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
      { text: "Architecture", link: "/architecture/" },
      { text: "Documentation", link: "/contributing/documentation-style-guide" }
    ],
    sidebar: {
      "/architecture/": [
        {
          text: "Architecture decisions",
          items: [
            { text: "Decision index", link: "/architecture/" },
            { text: "PostgreSQL Chronicle", link: "/architecture/0001-postgresql-chronicle" },
            { text: "Durable worker jobs", link: "/architecture/0002-postgresql-worker-jobs" },
            { text: "Story Engine ownership", link: "/architecture/0003-worker-owned-story-engine" },
            { text: "World Library versioning", link: "/architecture/0007-world-library-versioning" },
            { text: "Illustration pipeline", link: "/architecture/0008-independent-illustration-pipeline" },
            { text: "Schema migrations", link: "/architecture/0009-automatic-schema-migrations" }
          ]
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
