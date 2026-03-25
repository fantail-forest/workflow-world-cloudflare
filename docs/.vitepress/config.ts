import type { DefaultTheme, HeadConfig } from "vitepress";
import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { BANNER_STORAGE_KEY } from "./banner";
import type { DocsThemeConfig } from "./theme-config";

function devBannerRestoreHead(dismissible: boolean): HeadConfig[] {
  if (!dismissible) return [];
  return [
    [
      "script",
      { id: "restore-dev-banner-preference" },
      `(() => {
  const restore = (key, cls, def = false) => {
    const saved = localStorage.getItem(key);
    if (saved ? saved !== "false" && Date.now() < +saved : def) {
      document.documentElement.classList.add(cls);
    }
  };
  restore(${JSON.stringify(BANNER_STORAGE_KEY)}, "banner-dismissed");
})();`,
    ],
  ];
}

const themeConfig: DocsThemeConfig = {
  bannerDismissible: false,

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
    {
      text: "Tutorials",
      items: [
        { text: "Bare Worker + CLI", link: "/tutorials/user-onboarding-worker" },
        { text: "Hono + Vite", link: "/tutorials/user-onboarding-hono-vite" },
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
};

export default withMermaid(
  defineConfig({
    title: "Cloudflare World for Workflow DevKit",
    description: "Deploy durable workflows to Cloudflare Workers with D1, Durable Objects, and Queues",

    base: "/workflow-world-cloudflare/",

    head: devBannerRestoreHead(!!themeConfig.bannerDismissible),

    themeConfig: themeConfig as DefaultTheme.Config,
  }),
);
