import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Workflow DevKit for Cloudflare",
  description: "Deploy durable workflows to Cloudflare Workers with D1, Durable Objects, and Queues",

  base: "/workflow-world-cloudflare/",

  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Configuration", link: "/configuration/" },
      { text: "Architecture", link: "/architecture/" },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Overview", link: "/" },
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Configuration",
        items: [
          { text: "How It Works", link: "/configuration/" },
          { text: "Choosing Format", link: "/configuration/choosing-format" },
          { text: "Custom Bindings", link: "/configuration/custom-bindings" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Resource Mapping", link: "/architecture/" },
          { text: "Resource Limits", link: "/architecture/resource-limits" },
        ],
      },
      {
        text: "Security",
        items: [{ text: "Security Model", link: "/security" }],
      },
      {
        text: "Vite Integration",
        items: [
          { text: "Overview", link: "/vite/" },
          { text: "Project Setup", link: "/vite/project-setup" },
          { text: "HMR", link: "/vite/hmr" },
        ],
      },
      {
        text: "Testing",
        items: [
          { text: "Overview", link: "/testing/" },
          { text: "Local Testing", link: "/testing/local-testing" },
        ],
      },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/fantail-forest/workflow-world-cloudflare",
      },
    ],

    search: {
      provider: "local",
    },
  },
});
