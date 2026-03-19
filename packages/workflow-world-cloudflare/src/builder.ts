import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseBuilder, type WorkflowManifest } from "@workflow/builders";
import * as esbuild from "esbuild";

const NODE_BUILTINS = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
  "console",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "sqlite",
  "stream",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

export interface CloudflareConfig {
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
  wranglerFormat?: "toml" | "jsonc";
}

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

  override async getInputFiles(): Promise<string[]> {
    const files = await super.getInputFiles();
    return files.filter((f) => !f.includes("/dist/") && !f.includes("/.wrangler/"));
  }

  async build(): Promise<void> {
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    const options = { inputFiles, tsconfigPath };

    const serviceDir = this.resolvePath("dist/service-worker");
    await mkdir(serviceDir, { recursive: true });

    const stepsManifest = await this.buildStepsBundle(options);

    const { workflowNames, workflowsManifest } = await this.buildWorkflowsBundleForCloudflare(options);

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

    const funcNameByWorkflowId = await this.registerWorkflowFunctions(workflowNames);
    await this.patchFlowHandlerVm();

    await this.generateServiceWorkerEntry();
    await this.generateServiceWorkerWranglerConfig();
    await this.updateUserWranglerConfig();
    await this.generateClientLibrary(funcNameByWorkflowId);
  }

  // ---------------------------------------------------------------------------
  // Steps & Workflows bundles (unchanged — output into dist/)
  // ---------------------------------------------------------------------------

  private async buildStepsBundle({ inputFiles, tsconfigPath }: { inputFiles: string[]; tsconfigPath?: string }) {
    console.log("Creating steps bundle at", this.cloudflareConfig.stepsBundlePath);
    const stepsBundlePath = this.resolvePath(this.cloudflareConfig.stepsBundlePath);
    await this.ensureDirectory(stepsBundlePath);
    const { manifest } = await this.createStepsBundle({ outfile: stepsBundlePath, inputFiles, tsconfigPath });
    return manifest;
  }

  private async registerWorkflowFunctions(workflowNames: string[]): Promise<Map<string, string>> {
    const stepsBundlePath = this.resolvePath(this.cloudflareConfig.stepsBundlePath);
    const content = await readFile(stepsBundlePath, "utf8");

    const funcNameByWorkflowId = new Map<string, string>();
    const lines = content.split("\n");
    for (const line of lines) {
      const m = line.match(/^(\w+)\.workflowId\s*=\s*["']([^"']+)["']/);
      if (m?.[1] && m?.[2]) funcNameByWorkflowId.set(m[2], m[1]);
    }

    const registrations = workflowNames
      .filter((id) => funcNameByWorkflowId.has(id))
      .map((id) => {
        const fn = funcNameByWorkflowId.get(id);
        if (!fn) throw new Error(`Workflow function not found for ID: ${id}`);
        return `  __wf_fns.set(${JSON.stringify(id)}, ${fn});`;
      })
      .join("\n");

    if (!registrations) return funcNameByWorkflowId;

    const snippet = [
      "",
      "// -- CloudflareBuilder: register workflow functions for the vm.ts polyfill --",
      "var __wf_fns = globalThis.__workflow_cloudflare_functions = globalThis.__workflow_cloudflare_functions || new Map();",
      registrations,
    ].join("\n");

    const treeShakeIdx = content.lastIndexOf("\n0 && (module.exports");
    const patched =
      treeShakeIdx >= 0
        ? `${content.slice(0, treeShakeIdx)}\n${snippet}${content.slice(treeShakeIdx)}`
        : `${content}\n${snippet}\n`;

    await writeFile(stepsBundlePath, patched, "utf8");
    return funcNameByWorkflowId;
  }

  private async patchFlowHandlerVm(): Promise<void> {
    const flowBundlePath = this.resolvePath(this.cloudflareConfig.workflowsBundlePath);
    let content: string;
    try {
      content = await readFile(flowBundlePath, "utf8");
    } catch {
      return;
    }

    if (!content.includes('require("node:vm")')) return;

    const codeMatch = content.match(/var workflowCode\d*\s*=\s*`([\s\S]*?)`;/);
    if (codeMatch?.[1]) {
      const rawCode = codeMatch[1].replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");

      const factoryCode = [
        "",
        "// -- CloudflareBuilder: pre-compiled workflow code factory --",
        "globalThis.__workflow_cloudflare_code_factory = function(__wf_ctx) {",
        "  var globalThis = __wf_ctx;",
        rawCode,
        "  return __wf_ctx.__private_workflows;",
        "};",
      ].join("\n");

      const treeShakeIdx = content.lastIndexOf("\n0 && (module.exports");
      content =
        treeShakeIdx >= 0
          ? `${content.slice(0, treeShakeIdx)}\n${factoryCode}${content.slice(treeShakeIdx)}`
          : `${content}\n${factoryCode}\n`;
    }

    const serviceDir = this.resolvePath("dist/service-worker");
    const polyfillDest = join(serviceDir, "_vm-polyfill.js");

    const thisDir = dirname(fileURLToPath(import.meta.url));
    const polyfillEntry = join(thisDir, "polyfills", "vm.js");
    await esbuild.build({
      entryPoints: [polyfillEntry],
      outfile: polyfillDest,
      bundle: true,
      format: "cjs",
      platform: "neutral",
      logLevel: "warning",
    });

    const patched = content.replace(/require\("node:vm"\)/g, 'require("./service-worker/_vm-polyfill.js")');
    await writeFile(flowBundlePath, patched, "utf8");
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

    return { workflowCodeString, workflowNames, workflowsManifest: manifest };
  }

  private async buildWebhookFunction(): Promise<void> {
    console.log("Creating webhook bundle at", this.cloudflareConfig.webhookBundlePath);
    const webhookBundlePath = this.resolvePath(this.cloudflareConfig.webhookBundlePath);
    await this.ensureDirectory(webhookBundlePath);
    await this.createWebhookBundle({ outfile: webhookBundlePath });
  }

  private async generateClientLibrary(funcNameByWorkflowId: Map<string, string>): Promise<void> {
    const clientPath = this.cloudflareConfig.clientBundlePath;
    if (!clientPath) return;

    const outfile = this.resolvePath(clientPath);
    await this.ensureDirectory(outfile);

    const stubs = [...funcNameByWorkflowId.entries()]
      .map(
        ([workflowId, funcName]) =>
          `export function ${funcName}() { throw new Error("${funcName} is a workflow stub — invoke it via start()"); }\n${funcName}.workflowId = ${JSON.stringify(workflowId)};`,
      )
      .join("\n\n");

    await writeFile(outfile, `// Auto-generated client library — do not edit\n${stubs}\n`, "utf8");
  }

  // ---------------------------------------------------------------------------
  // Service Worker entry — self-contained, with RPC entrypoint
  // ---------------------------------------------------------------------------

  private async generateServiceWorkerEntry(): Promise<void> {
    const serviceDir = this.resolvePath("dist/service-worker");
    await mkdir(serviceDir, { recursive: true });

    const entryPath = join(serviceDir, "_worker.js");

    // The service worker is self-contained: it owns DOs, queues, inspect,
    // webhooks, and exposes an RPC entrypoint for the proxy world.
    const entryContent = `// Auto-generated by CloudflareBuilder -- do not edit
import { setWorld } from '@workflow/core/runtime';
import { createCloudflareWorld, envStorage, executionContextStorage, processQueueBatch, handleInspectRequest } from 'workflow-world-cloudflare';
import { WorkflowServiceEntrypoint } from 'workflow-world-cloudflare/service-entrypoint';
export { WorkflowRunDO, WorkflowStreamDO } from 'workflow-world-cloudflare/durable-objects';
export { WorkflowServiceEntrypoint };
import '../step-handler.js';

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
    const world = await getWorld(env);
    return executionContextStorage.run(ctx, () =>
      envStorage.run(env, async () => {
        const url = new URL(request.url);
        const path = url.pathname;

        // Auth-gated inspect endpoints
        if (path.startsWith('/.well-known/workflow/v1/inspect')) {
          const inspectResponse = await handleInspectRequest(request, cachedWorld, env.WORKFLOW_INSPECT_TOKEN, env.RUN_DO);
          if (inspectResponse) return inspectResponse;
        }

        // Auth-gated webhook endpoint
        if (path.startsWith('/.well-known/workflow/v1/webhook')) {
          const { POST } = await import('../webhook-handler.js');
          return POST(request);
        }

        // Opt-in manifest endpoint
        if (path === '/.well-known/workflow/v1/manifest.json') {
          if (env.WORKFLOW_PUBLIC_MANIFEST !== '1') {
            return new Response('Not Found', { status: 404 });
          }
          const manifest = await import('../../.well-known/workflow/v1/manifest.json');
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
        const flowHandler = (await import('../flow-handler.js')).POST;
        const stepHandler = (await import('../step-handler.js')).POST;
        await processQueueBatch(batch, { flow: flowHandler, step: stepHandler }, env);
      })
    );
  },
};
`;

    const polyfillsDir = join(dirname(new URL(import.meta.url).pathname), "polyfills");
    const tmpEntryPath = join(serviceDir, "_entry.tmp.js");
    await writeFile(tmpEntryPath, entryContent, "utf8");

    try {
      await esbuild.build({
        entryPoints: [tmpEntryPath],
        outfile: entryPath,
        bundle: true,
        allowOverwrite: true,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        mainFields: ["module", "main"],
        conditions: ["workerd", "worker", "import"],
        alias: {
          "node:vm": join(polyfillsDir, "vm.js"),
          "node:module": join(polyfillsDir, "module.js"),
        },
        external: [
          "cloudflare:workers",
          "node:async_hooks",
          "../step-handler.js",
          "../flow-handler.js",
          "../webhook-handler.js",
          "../../.well-known/workflow/v1/manifest.json",
          "@workflow/core",
          "@workflow/core/*",
          "workflow-world-cloudflare",
          "workflow-world-cloudflare/*",
          ...NODE_BUILTINS.flatMap((m) => [m, `node:${m}`]),
        ],
        write: true,
        minify: false,
      });
    } finally {
      await import("node:fs/promises").then((fs) => fs.unlink(tmpEntryPath).catch(() => {}));
    }
  }

  // ---------------------------------------------------------------------------
  // Wrangler configs — service worker + user worker
  // ---------------------------------------------------------------------------

  private async generateServiceWorkerWranglerConfig(): Promise<void> {
    const format = this.cloudflareConfig.wranglerFormat ?? "toml";
    const appName = this.resolveAppName();
    const names = deriveResourceNames(appName);
    const serviceDir = this.resolvePath("dist/service-worker");
    const workingDir = this.cloudflareConfig.workingDir || process.cwd();

    const config: Record<string, unknown> = {
      name: names.serviceWorkerName,
      main: "_worker.js",
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
    mergeUserBindings(config, userConfig);

    const outputFile = format === "jsonc" ? join(serviceDir, "wrangler.jsonc") : join(serviceDir, "wrangler.toml");

    if (format === "jsonc") {
      const header = "// Auto-generated by `workflow-cloudflare build` -- do not edit\n";
      await writeFile(outputFile, header + JSON.stringify(config, null, 2));
    } else {
      const header = "# Auto-generated by `workflow-cloudflare build` -- do not edit\n\n";
      await writeFile(outputFile, header + toToml(config));
    }

    console.log(`Generated service worker wrangler config at ${outputFile}`);
  }

  private async updateUserWranglerConfig(): Promise<void> {
    const format = this.cloudflareConfig.wranglerFormat ?? "toml";
    const workingDir = this.cloudflareConfig.workingDir || process.cwd();
    const appName = this.resolveAppName();
    const names = deriveResourceNames(appName);

    const baseConfig: Record<string, unknown> = {
      name: names.workerName,
      compatibility_date: new Date().toISOString().split("T")[0],
      compatibility_flags: ["nodejs_compat"],
      services: [
        {
          binding: "WORKFLOW",
          service: names.serviceWorkerName,
          entrypoint: "WorkflowServiceEntrypoint",
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
        "// Auto-generated by `workflow-cloudflare build`\n// Do not edit directly. Modify wrangler.app.jsonc or wrangler.app.toml instead.\n";
      await writeFile(outputFile, header + JSON.stringify(merged, null, 2));
    } else {
      const header =
        "# Auto-generated by `workflow-cloudflare build`\n# Do not edit directly. Modify wrangler.app.toml or wrangler.app.jsonc instead.\n\n";
      await writeFile(outputFile, header + toToml(merged));
    }

    console.log(`Generated user wrangler config at ${outputFile}`);
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

export function deriveResourceNames(appName: string) {
  return {
    workerName: appName,
    serviceWorkerName: `${appName}-workflow`,
    d1DatabaseName: `${appName}-workflow-db`,
    runQueueName: `${appName}-workflow-runs`,
    stepQueueName: `${appName}-workflow-steps`,
  };
}

const SERVICE_ONLY_KEYS = new Set(["name", "main", "compatibility_date", "compatibility_flags", "services"]);

/**
 * Propagates user bindings (KV, D1, R2, vars, etc.) into the service worker
 * config so workflow steps can access them via getCloudflareEnv().
 */
function mergeUserBindings(config: Record<string, unknown>, userConfig: Record<string, unknown> | null): void {
  if (!userConfig) return;
  for (const [key, value] of Object.entries(userConfig)) {
    if (SERVICE_ONLY_KEYS.has(key)) continue;
    const existing = config[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      config[key] = [...existing, ...value];
    } else if (!(key in config)) {
      config[key] = value;
    }
  }
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
