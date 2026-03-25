<script setup lang="ts">
import { useElementSize } from "@vueuse/core";
import { inBrowser, useData } from "vitepress";
import { computed, ref, watchEffect } from "vue";
import { BANNER_DISMISS_TTL_MS, BANNER_STORAGE_KEY } from "../banner";
import type { DocsThemeConfig } from "../theme-config";

const { theme } = useData();
const bannerDismissible = computed(
  () => (theme.value as DocsThemeConfig).bannerDismissible === true,
);

const el = ref<HTMLElement>();
const { height } = useElementSize(el);

watchEffect(() => {
  if (!inBrowser) return;
  const root = document.documentElement;
  if (root.classList.contains("banner-dismissed")) {
    root.style.setProperty("--vp-layout-top-height", "0px");
    return;
  }
  if (height.value) {
    root.style.setProperty("--vp-layout-top-height", `${height.value + 16}px`);
  }
});

const dismiss = () => {
  if (!bannerDismissible.value) return;
  localStorage.setItem(
    BANNER_STORAGE_KEY,
    (Date.now() + BANNER_DISMISS_TTL_MS).toString(),
  );
  const root = document.documentElement;
  root.classList.add("banner-dismissed");
  root.style.setProperty("--vp-layout-top-height", "0px");
};
</script>

<template>
  <div ref="el" class="banner" :class="{ 'banner--dismissible': bannerDismissible }">
    <div class="text">
      This project is currently in development and is not yet fully working.
    </div>

    <button
      v-if="bannerDismissible"
      type="button"
      class="dismiss"
      aria-label="Dismiss banner"
      @click="dismiss"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
        />
      </svg>
    </button>
  </div>
</template>

<style>
html {
  --vp-layout-top-height: 88px;
}

@media (min-width: 375px) {
  html {
    --vp-layout-top-height: 64px;
  }
}

@media (min-width: 768px) {
  html {
    --vp-layout-top-height: 40px;
  }
}
</style>

<style scoped>
.banner {
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: var(--vp-z-index-layout-top);

  padding: 8px;
  text-align: center;

  /* Same palette as primary brand buttons; :root / .dark swap --vp-c-brand-* */
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--vp-c-brand-1) 28%, transparent);

  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.banner.banner--dismissible {
  justify-content: space-between;
}

.banner-dismissed .banner {
  display: none;
}

.text {
  flex: 1;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5;
}

.dismiss {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 4px;
  border: none;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.dismiss:hover {
  background: color-mix(in srgb, var(--vp-button-brand-text) 16%, transparent);
}

.dismiss:focus-visible {
  outline: 2px solid var(--vp-button-brand-text);
  outline-offset: 2px;
}

svg {
  width: 20px;
  height: 20px;
  display: block;
}
</style>
