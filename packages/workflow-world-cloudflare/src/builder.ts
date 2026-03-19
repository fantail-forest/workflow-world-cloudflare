import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BaseBuilder, type WorkflowManifest } from "@workflow/builders";
import * as esbuild from "esbuild";

/**
 * Configuration for Cloudflare Workers builds.
 */
export interface CloudflareConfig {
  /**
   * Application name used to derive the Worker name and namespace all
   * account-scoped Cloudflare resources (D1 database, Queues).
   *
   * For example, `appName: 'billing'` produces:
   * - Worker name: `billing`
   * - D1 database: `billing-workflow-db`
   * - Queues: `billing-workflow-runs`, `billing-workflow-steps`
   *
   * Defaults to the working directory name.
   */
  appName?: string;
  watch?: boolean;
  dirs: string[];
  workingDir: string;
  clientBundlePath?: string;
  externalPackages?: string[];
  workflowManifestPath?: string;
  debugFilePrefix?: string;
  suppressCreateWorkflowsBundleLogs?: boolean;
  suppressCreateWorkflowsBundleWarnings?: boolean;
  suppressCreateWebhookBundleLogs?: boolean;
  suppressCreateManifestLogs?: boolean;
  buildTarget: "cloudflare";
  stepsBundlePath: string;
  workflowsBundlePath: string;
  webhookBundlePath: string;
  /** Output format for wrangler config: 'toml' (default) or 'jsonc' */
  wranglerFormat?: "toml" | "jsonc";
}

/**
 * Cloudflare Workers builder.
 *
 * Produces a Worker-compatible bundle with:
 * - Module aliases for node:vm, node:module, @vercel/functions, @vercel/queue, cbor-x
 * - Pre-imported workflow functions registered in globalThis.__workflow_cloudflare_functions
 * - Generated Worker entry point with setWorld(), envStorage.run(), executionContextStorage.run()
 * - Builder-owned wrangler config with user overrides merged in
 */
export class CloudflareBuilder extends BaseBuilder {
  private cloudflareConfig: CloudflareConfig;

  constructor(config: CloudflareConfig) {
    super({
      ...config,
      buildTarget: "cloudflare" as never,
      dirs: ["."],
    });
    this.cloudflareConfig = config;
  }

  private resolveAppName(): string {
    if (this.cloudflareConfig.appName) return this.cloudflareConfig.appName;
    const dir = this.cloudflareConfig.workingDir || process.cwd();
    return basename(dir) || "workflow-app";
  }

  async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();

    const options = { inputFiles, tsconfigPath };

    const stepsManifest = await this.buildStepsBundle(options);

    const {
      workflowCodeString: _wcs,
      workflowNames,
      workflowsManifest,
    } = await this.buildWorkflowsBundleForCloudflare(options);

    await this.buildWebhookFunction();

    const manifest = {
      steps: { ...stepsManifest.steps, ...workflowsManifest.steps },
      workflows: {
        ...stepsManifest.workflows,
        ...workflowsManifest.workflows,
      },
      classes: { ...stepsManifest.classes, ...workflowsManifest.classes },
    };

    const workflowBundlePath = this.resolvePath(this.cloudflareConfig.workflowsBundlePath);
    const manifestDir = this.resolvePath(".well-known/workflow/v1");
    await this.createManifest({
      workflowBundlePath,
      manifestDir,
      manifest,
    });

    await this.generateWorkerEntry(workflowNames);

    await this.generateWranglerConfig();

    await this.createClientLibrary();
  }

  private async buildStepsBundle({ inputFiles, tsconfigPath }: { inputFiles: string[]; tsconfigPath?: string }) {
    console.log("Creating steps bundle at", this.cloudflareConfig.stepsBundlePath);

    const stepsBundlePath = this.resolvePath(this.cloudflareConfig.stepsBundlePath);
    await this.ensureDirectory(stepsBundlePath);

    const { manifest } = await this.createStepsBundle({
      outfile: stepsBundlePath,
      inputFiles,
      tsconfigPath,
    });

    return manifest;
  }

  private async buildWorkflowsBundleForCloudflare({
    inputFiles,
    tsconfigPath,
  }: {
    inputFiles: string[];
    tsconfigPath?: string;
  }): Promise<{
    workflowCodeString: string;
    workflowNames: string[];
    workflowsManifest: WorkflowManifest;
  }> {
    console.log("Creating workflows bundle at", this.cloudflareConfig.workflowsBundlePath);

    const workflowBundlePath = this.resolvePath(this.cloudflareConfig.workflowsBundlePath);
    await this.ensureDirectory(workflowBundlePath);

    const { manifest } = await this.createWorkflowsBundle({
      outfile: workflowBundlePath,
      inputFiles,
      tsconfigPath,
    });

    const bundleContent = await readFile(workflowBundlePath, "utf8");

    const workflowNames: string[] = [];
    const setCallRegex = /__private_workflows\.set\(["']([^"']+)["']/g;
    for (let match = setCallRegex.exec(bundleContent); match !== null; match = setCallRegex.exec(bundleContent)) {
      const name = match[1];
      if (name !== undefined) workflowNames.push(name);
    }

    const workflowCodeMatch = bundleContent.match(/const workflowCode\s*=\s*`([\s\S]*?)`;/);
    const workflowCodeGroup = workflowCodeMatch?.[1];
    const workflowCodeString = workflowCodeGroup
      ? workflowCodeGroup.replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\")
      : "";

    return {
      workflowCodeString,
      workflowNames,
      workflowsManifest: manifest,
    };
  }

  private async buildWebhookFunction(): Promise<void> {
    console.log("Creating webhook bundle at", this.cloudflareConfig.webhookBundlePath);

    const webhookBundlePath = this.resolvePath(this.cloudflareConfig.webhookBundlePath);
    await this.ensureDirectory(webhookBundlePath);

    await this.createWebhookBundle({
      outfile: webhookBundlePath,
    });
  }

  private async generateWorkerEntry(workflowNames: string[]): Promise<void> {
    const distDir = this.resolvePath("dist");
    await mkdir(distDir, { recursive: true });

    const entryPath = join(distDir, "_worker.js");

    const workflowImports = workflowNames
      .map((name, i) => `import { ${name} as wf_${i} } from './workflow/step-handler.js';`)
      .join("\n");

    const workflowMapEntries = workflowNames.map((name, i) => `  ['${name}', wf_${i}]`).join(",\n");

    const entryContent = `// Auto-generated by CloudflareBuilder -- do not edit
import { setWorld } from '@workflow/core';
import { createCloudflareWorld, envStorage, executionContextStorage, processQueueBatch } from 'workflow-world-cloudflare';
export { WorkflowRunDO, WorkflowStreamDO } from 'workflow-world-cloudflare/durable-objects';

${workflowImports}

globalThis.__workflow_cloudflare_functions = new Map([
${workflowMapEntries}
]);

let cachedWorld = null;

async function getWorld(env) {
  if (!cachedWorld) {
    cachedWorld = await createCloudflareWorld(env);
    setWorld(cachedWorld);
  }
  return cachedWorld;
}

export default {
  async fetch(request, env, ctx) {
    await getWorld(env);
    return executionContextStorage.run(ctx, () =>
      envStorage.run(env, async () => {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path.startsWith('/.well-known/workflow/v1/flow')) {
          const { POST } = await import('./workflow/flow-handler.js');
          return POST(request);
        }
        if (path.startsWith('/.well-known/workflow/v1/step')) {
          const { POST } = await import('./workflow/step-handler.js');
          return POST(request);
        }
        if (path.startsWith('/.well-known/workflow/v1/webhook')) {
          const { POST } = await import('./workflow/webhook-handler.js');
          return POST(request);
        }
        if (path === '/.well-known/workflow/v1/manifest.json') {
          const manifest = await import('./.well-known/workflow/v1/manifest.json');
          return Response.json(manifest.default || manifest);
        }

        return new Response('Not Found', { status: 404 });
      })
    );
  },

  async queue(batch, env, ctx) {
    await getWorld(env);
    return executionContextStorage.run(ctx, () =>
      envStorage.run(env, async () => {
        const flowHandler = (await import('./workflow/flow-handler.js')).POST;
        const stepHandler = (await import('./workflow/step-handler.js')).POST;
        await processQueueBatch(batch, { flow: flowHandler, step: stepHandler }, env);
      })
    );
  },
};
`;

    const polyfillsDir = join(dirname(new URL(import.meta.url).pathname), "polyfills");

    await esbuild.build({
      stdin: {
        contents: entryContent,
        resolveDir: distDir,
        sourcefile: "_worker.js",
        loader: "js",
      },
      outfile: entryPath,
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      conditions: ["workerd", "worker"],
      alias: {
        "node:vm": join(polyfillsDir, "vm.js"),
        "node:module": join(polyfillsDir, "module.js"),
        "@vercel/functions": join(polyfillsDir, "vercel-functions.js"),
        "@vercel/queue": join(polyfillsDir, "vercel-queue.js"),
        "cbor-x": "cbor-x/dist/index-no-eval.cjs",
      },
      external: ["cloudflare:workers", "node:async_hooks", "node:path", "node:crypto"],
      write: true,
      minify: false,
    });
  }

  private async generateWranglerConfig(): Promise<void> {
    const format = this.cloudflareConfig.wranglerFormat ?? "toml";
    const workingDir = this.cloudflareConfig.workingDir || process.cwd();
    const appName = this.resolveAppName();
    const names = deriveResourceNames(appName);

    const baseConfig: Record<string, unknown> = {
      name: names.workerName,
      main: "dist/_worker.js",
      compatibility_date: new Date().toISOString().split("T")[0],
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [{ binding: "WORKFLOW_DB", database_name: names.d1DatabaseName }],
      durable_objects: {
        bindings: [
          { name: "RUN_DO", class_name: "WorkflowRunDO" },
          { name: "STREAM_DO", class_name: "WorkflowStreamDO" },
        ],
      },
      queues: {
        producers: [
          { binding: "WORKFLOW_QUEUE", queue: names.runQueueName },
          { binding: "WORKFLOW_STEP_QUEUE", queue: names.stepQueueName },
        ],
        consumers: [{ queue: names.runQueueName }, { queue: names.stepQueueName }],
      },
      migrations: [
        {
          tag: "v1",
          new_sqlite_classes: ["WorkflowRunDO", "WorkflowStreamDO"],
        },
      ],
    };

    const userConfig = await this.readUserOverrideConfig(workingDir);

    const merged = userConfig ? deepMerge(baseConfig, userConfig) : baseConfig;

    // Determine output format: user file format > explicit flag > toml default
    let outputFormat = format;
    try {
      await readFile(join(workingDir, "wrangler.app.jsonc"), "utf8");
      if (!this.cloudflareConfig.wranglerFormat) outputFormat = "jsonc";
    } catch {}
    try {
      await readFile(join(workingDir, "wrangler.app.toml"), "utf8");
      if (!this.cloudflareConfig.wranglerFormat) outputFormat = "toml";
    } catch {}

    const outputFile =
      outputFormat === "jsonc" ? join(workingDir, "wrangler.jsonc") : join(workingDir, "wrangler.toml");

    if (outputFormat === "jsonc") {
      const header =
        "// Auto-generated by `workflow build --target cloudflare`\n// Do not edit directly. Modify wrangler.app.jsonc or wrangler.app.toml instead.\n";
      await writeFile(outputFile, header + JSON.stringify(merged, null, 2));
    } else {
      const header =
        "# Auto-generated by `workflow build --target cloudflare`\n# Do not edit directly. Modify wrangler.app.toml or wrangler.app.jsonc instead.\n\n";
      await writeFile(outputFile, header + toToml(merged));
    }

    console.log(`Generated wrangler config at ${outputFile}`);
  }

  private async readUserOverrideConfig(workingDir: string): Promise<Record<string, unknown> | null> {
    let tomlContent: string | null = null;
    let jsoncContent: string | null = null;

    try {
      tomlContent = await readFile(join(workingDir, "wrangler.app.toml"), "utf8");
    } catch {}

    try {
      jsoncContent = await readFile(join(workingDir, "wrangler.app.jsonc"), "utf8");
    } catch {}

    if (tomlContent) {
      return parseToml(tomlContent);
    }

    if (jsoncContent) {
      const stripped = jsoncContent.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      return JSON.parse(stripped) as Record<string, unknown>;
    }

    return null;
  }
}

// --- TOML utilities ---

function classifyTomlEntries(obj: Record<string, unknown>) {
  const simple: [string, unknown][] = [];
  const tables: [string, Record<string, unknown>][] = [];
  const arrayTables: [string, Record<string, unknown>[]][] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
        arrayTables.push([key, value as Record<string, unknown>[]]);
      } else {
        simple.push([key, value]);
      }
    } else if (typeof value === "object" && value !== null) {
      tables.push([key, value as Record<string, unknown>]);
    } else {
      simple.push([key, value]);
    }
  }
  return { simple, tables, arrayTables };
}

function renderTomlTable(key: string, table: Record<string, unknown>, prefix: string): string {
  const fullKey = prefix ? `${prefix}.${key}` : key;
  const hasNestedTables = Object.values(table).some(
    (v) =>
      (typeof v === "object" && v !== null && !Array.isArray(v)) ||
      (Array.isArray(v) && v.length > 0 && typeof v[0] === "object"),
  );
  if (hasNestedTables) {
    return `\n[${fullKey}]\n${toToml(table, fullKey)}`;
  }
  const fields = Object.entries(table)
    .map(([k, v]) => `${k} = ${toTomlValue(v)}\n`)
    .join("");
  return `\n[${fullKey}]\n${fields}`;
}

function renderTomlArrayTable(key: string, items: Record<string, unknown>[], prefix: string): string {
  const fullKey = prefix ? `${prefix}.${key}` : key;
  return items
    .map(
      (item) =>
        `\n[[${fullKey}]]\n${Object.entries(item)
          .map(([k, v]) => `${k} = ${toTomlValue(v)}\n`)
          .join("")}`,
    )
    .join("");
}

function toToml(obj: Record<string, unknown>, prefix = ""): string {
  const { simple, tables, arrayTables } = classifyTomlEntries(obj);
  const simpleStr = simple.map(([key, value]) => `${key} = ${toTomlValue(value)}\n`).join("");
  const tablesStr = tables.map(([key, table]) => renderTomlTable(key, table, prefix)).join("");
  const arrayTablesStr = arrayTables.map(([key, items]) => renderTomlArrayTable(key, items, prefix)).join("");
  return simpleStr + tablesStr + arrayTablesStr;
}

function toTomlValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{ ${entries.map(([k, v]) => `${k} = ${toTomlValue(v)}`).join(", ")} }`;
  }
  return String(value);
}

function tomlNavigate(root: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  let obj = root;
  for (const seg of segments) {
    const s = seg.trim();
    if (!(s in obj)) obj[s] = {};
    obj = obj[s] as Record<string, unknown>;
  }
  return obj;
}

function tomlArrayTable(result: Record<string, unknown>, line: string): Record<string, unknown> | null {
  const m = line.match(/^\[\[(.+)]]$/);
  if (!m) return null;
  const key = m[1];
  if (key === undefined) return null;
  const parts = key.split(".").map((s) => s.trim());
  const lastKey = parts.at(-1);
  if (lastKey === undefined) return null;
  const parent = tomlNavigate(result, parts.slice(0, -1));
  if (!Array.isArray(parent[lastKey])) parent[lastKey] = [];
  const newItem: Record<string, unknown> = {};
  (parent[lastKey] as Record<string, unknown>[]).push(newItem);
  return newItem;
}

function tomlTable(result: Record<string, unknown>, line: string): Record<string, unknown> | null {
  const m = line.match(/^\[(.+)]$/);
  if (!m) return null;
  const key = m[1];
  if (key === undefined) return null;
  return tomlNavigate(
    result,
    key.split(".").map((s) => s.trim()),
  );
}

function tomlKV(obj: Record<string, unknown>, line: string): void {
  const m = line.match(/^([^=]+)=(.+)$/);
  if (!m) return;
  const rawKey = m[1];
  const rawVal = m[2];
  if (rawKey === undefined || rawVal === undefined) return;
  obj[rawKey.trim()] = parseTomlValue(rawVal.trim());
}

function parseToml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentObj = result;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const arrResult = tomlArrayTable(result, line);
    if (arrResult !== null) {
      currentObj = arrResult;
      continue;
    }
    const tblResult = tomlTable(result, line);
    if (tblResult !== null) {
      currentObj = tblResult;
      continue;
    }
    tomlKV(currentObj, line);
  }
  return result;
}

function parseTomlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);

  const strMatch = raw.match(/^"(.*)"$/);
  if (strMatch) return strMatch[1];
  const strMatch2 = raw.match(/^'(.*)'$/);
  if (strMatch2) return strMatch2[1];

  if (raw.startsWith("[")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((v) => parseTomlValue(v.trim()));
  }

  return raw;
}

/**
 * Derive account-scoped Cloudflare resource names from an app name.
 * Exported for testing.
 */
export function deriveResourceNames(appName: string) {
  return {
    workerName: appName,
    d1DatabaseName: `${appName}-workflow-db`,
    runQueueName: `${appName}-workflow-runs`,
    stepQueueName: `${appName}-workflow-steps`,
  };
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    if (
      typeof targetValue === "object" &&
      targetValue !== null &&
      !Array.isArray(targetValue) &&
      typeof sourceValue === "object" &&
      sourceValue !== null &&
      !Array.isArray(sourceValue)
    ) {
      result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}
