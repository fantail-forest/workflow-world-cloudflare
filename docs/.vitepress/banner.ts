/**
 * Dev banner: `localStorage` key and dismiss TTL (only when `themeConfig.bannerDismissible`
 * is true). The restore script in `config.ts` must use the same `BANNER_STORAGE_KEY`.
 */

export const BANNER_STORAGE_KEY = "workflow-world-dev-banner";

/** Hide-after-dismiss duration */
export const BANNER_DISMISS_TTL_MS = 86_400_000;
