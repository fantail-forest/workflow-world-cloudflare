import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { workflowCloudflare } from "vite-plugin-workflow-cloudflare";

export default defineConfig({
  plugins: [workflowCloudflare({ appName: "user-onboarding" }), cloudflare({ persistState: true })],
});
