import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { applySwcTransform } from "@workflow/builders";
import type { Plugin, ResolvedConfig } from "vite";

const VIRTUAL_MODULE_WORKFLOW_CODE = "\0virtual:workflow-code";
const VIRTUAL_MODULE_WORKFLOW_FUNCTIONS = "\0virtual:workflow-functions";

function extractWorkflowNames(code: string): string[] {
  const names: string[] = [];
  const regex = /__private_workflows\.set\(["']([^"']+)["']/g;
  for (let match = regex.exec(code); match !== null; match = regex.exec(code)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

export interface WorkflowCloudflareOptions {
  /** Directories to scan for workflow files. Defaults to ['workflows'] */
  dirs?: string[];
  /** Working directory. Defaults to process.cwd() */
  workingDir?: string;
  /** App name for resource namespacing. Forwarded to CloudflareBuilder. */
  appName?: string;
  /** Wrangler config output format. Forwarded to CloudflareBuilder. */
  wranglerFormat?: "toml" | "jsonc";
}

/**
 * Vite plugin for Workflow DevKit on Cloudflare Workers.
 *
 * In dev mode: watches workflow source files, re-runs the SWC transform,
 * produces the workflow code string and static workflow function imports,
 * and feeds them into @cloudflare/vite-plugin's pipeline for HMR.
 *
 * In production (`vite build`): invokes CloudflareBuilder to produce the
 * full Worker bundle, wrangler config, and manifest.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { cloudflare } from '@cloudflare/vite-plugin';
 * import { workflowCloudflare } from 'vite-plugin-workflow-cloudflare';
 *
 * export default defineConfig({
 *   plugins: [
 *     workflowCloudflare({ appName: 'my-app' }),
 *     cloudflare({ configPath: './wrangler.toml', persistState: true }),
 *   ],
 * });
 * ```
 */
export function workflowCloudflare(options?: WorkflowCloudflareOptions): Plugin {
  const dirs = options?.dirs ?? ["workflows"];
  const workingDir = options?.workingDir ?? process.cwd();
  let isBuild = false;
  let workflowCodeString = "";
  let workflowNames: string[] = [];

  async function runTransform(): Promise<void> {
    const { glob } = await import("tinyglobby");
    const inputFiles = (
      await Promise.all(
        dirs.map((dir) =>
          glob(["**/*.{ts,tsx,js,jsx}"], {
            cwd: resolve(workingDir, dir),
            absolute: true,
            ignore: ["**/node_modules/**"],
          }),
        ),
      )
    ).flat();

    if (inputFiles.length === 0) return;

    const allCode: string[] = [];
    const newWorkflowNames: string[] = [];

    for (const file of inputFiles) {
      const source = await readFile(file, "utf8");
      const result = await applySwcTransform(relative(workingDir, file), source, "workflow", file);
      if (result.code) {
        allCode.push(result.code);
        newWorkflowNames.push(...extractWorkflowNames(result.code));
      }
    }

    workflowCodeString = allCode.join("\n");
    workflowNames = newWorkflowNames;
  }

  return {
    name: "workflow-cloudflare",
    enforce: "pre",

    async configResolved(config: ResolvedConfig) {
      isBuild = config.command === "build";
      try {
        await runTransform();
      } catch (err) {
        console.warn("[workflow-cloudflare] Initial transform failed:", err);
      }
    },

    resolveId(id) {
      if (id === "virtual:workflow-code") return VIRTUAL_MODULE_WORKFLOW_CODE;
      if (id === "virtual:workflow-functions") return VIRTUAL_MODULE_WORKFLOW_FUNCTIONS;
      return null;
    },

    load(id) {
      if (id === VIRTUAL_MODULE_WORKFLOW_CODE) {
        return `export const workflowCode = ${JSON.stringify(workflowCodeString)};`;
      }
      if (id === VIRTUAL_MODULE_WORKFLOW_FUNCTIONS) {
        const imports = workflowNames
          .map((name, i) => `import { ${name} as wf_${i} } from './workflows/${name}.js';`)
          .join("\n");
        const mapEntries = workflowNames.map((name, i) => `  ['${name}', wf_${i}]`).join(",\n");
        return `${imports}\nexport const functions = new Map([\n${mapEntries}\n]);\n`;
      }
      return null;
    },

    configureServer(server) {
      for (const dir of dirs) {
        const watchDir = resolve(workingDir, dir);
        server.watcher.add(watchDir);
      }
    },

    async handleHotUpdate({ file, server }) {
      // Check if the changed file is in a workflow directory
      const isWorkflowFile = dirs.some((dir) => file.startsWith(resolve(workingDir, dir)));

      if (!isWorkflowFile) return;

      console.log("[workflow-cloudflare] Re-transforming workflows...");
      await runTransform();

      // Invalidate virtual modules to trigger reload
      const codeModule = server.moduleGraph.getModuleById(VIRTUAL_MODULE_WORKFLOW_CODE);
      const functionsModule = server.moduleGraph.getModuleById(VIRTUAL_MODULE_WORKFLOW_FUNCTIONS);

      const modules = [];
      if (codeModule) {
        server.moduleGraph.invalidateModule(codeModule);
        modules.push(codeModule);
      }
      if (functionsModule) {
        server.moduleGraph.invalidateModule(functionsModule);
        modules.push(functionsModule);
      }

      return modules;
    },

    config() {
      return {
        resolve: {
          alias: [
            {
              find: "node:vm",
              replacement: resolve(workingDir, "node_modules/workflow-world-cloudflare/dist/polyfills/vm.js"),
            },
            {
              find: "node:module",
              replacement: resolve(workingDir, "node_modules/workflow-world-cloudflare/dist/polyfills/module.js"),
            },
            {
              find: "@vercel/functions",
              replacement: resolve(
                workingDir,
                "node_modules/workflow-world-cloudflare/dist/polyfills/vercel-functions.js",
              ),
            },
          ],
        },
        optimizeDeps: {
          exclude: ["workflow-world-cloudflare"],
        },
      };
    },

    async closeBundle() {
      if (!isBuild) return;

      console.log("[workflow-cloudflare] Running production build...");
      const { CloudflareBuilder } = await import("workflow-world-cloudflare/builder");

      const builder = new CloudflareBuilder({
        appName: options?.appName,
        buildTarget: "cloudflare" as const,
        dirs: ["."],
        workingDir,
        stepsBundlePath: "dist/step-handler.js",
        workflowsBundlePath: "dist/flow-handler.js",
        webhookBundlePath: "dist/webhook-handler.js",
        wranglerFormat: options?.wranglerFormat,
        suppressCreateWorkflowsBundleLogs: false,
        suppressCreateWorkflowsBundleWarnings: false,
        suppressCreateWebhookBundleLogs: false,
        suppressCreateManifestLogs: false,
      });

      await builder.build();
      console.log("[workflow-cloudflare] Production build complete.");
    },
  };
}
