import type { DefaultTheme } from "vitepress";

/** Default-theme options plus docs-only fields (see `config.ts` → `themeConfig`). */
export type DocsThemeConfig = DefaultTheme.Config & {
  bannerDismissible?: boolean;
};
