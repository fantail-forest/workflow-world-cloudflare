const INSPECT_BASE = "/.well-known/workflow/v1/inspect";

interface InspectClientConfig {
  url: string;
  token: string;
}

async function inspectFetch(
  config: InspectClientConfig,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${INSPECT_BASE}${path}`, config.url);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Inspect request failed (${res.status}): ${body}`);
  }

  return res.json();
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

function getPositionalArgs(args: string[]) {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function formatTable(data: Record<string, unknown>[]): string {
  if (data.length === 0) return "(no results)";

  const first = data[0];
  if (first === undefined) return "(no results)";
  const keys = Object.keys(first);
  const widths = keys.map((k) => Math.max(k.length, ...data.map((row) => String(row[k] ?? "").length)));

  const header = keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  const rows = data.map((row) => keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i] ?? 0)).join("  "));

  return [header, separator, ...rows].join("\n");
}

function printResult(result: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result && typeof result === "object" && "data" in result && Array.isArray((result as { data: unknown[] }).data)) {
    const items = (result as { data: unknown[] }).data;
    if (items.length === 0) {
      console.log("(no results)");
    } else {
      console.log(formatTable(items as Record<string, unknown>[]));
      const paginated = result as {
        data: unknown[];
        cursor?: string;
        hasMore?: boolean;
      };
      if (paginated.hasMore) {
        console.log(`\n... more results available (cursor: ${paginated.cursor})`);
      }
    }
  } else if (result && typeof result === "object") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(String(result));
  }
}

interface SubcommandOpts {
  config: InspectClientConfig;
  flags: Record<string, string | boolean>;
  positional: string[];
  limit: string;
  runId: string | undefined;
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) {
    console.error(`Usage: ${usage}`);
    process.exit(1);
  }
  return value;
}

async function cmdRuns({ config, flags, limit }: SubcommandOpts): Promise<unknown> {
  const workflowName = flags["workflow-name"] as string | undefined;
  const params: Record<string, string> = { limit };
  if (workflowName) params.workflowName = workflowName;
  return inspectFetch(config, "/runs", params);
}

async function cmdRun({ config, positional }: SubcommandOpts): Promise<unknown> {
  const id = requireArg(positional[1], "workflow-cloudflare inspect run <runId>");
  return inspectFetch(config, `/runs/${id}`);
}

async function cmdSteps({ config, positional, limit, runId }: SubcommandOpts): Promise<unknown> {
  const rid = requireArg(runId || positional[1], "workflow-cloudflare inspect steps --run-id <runId>");
  return inspectFetch(config, `/runs/${rid}/steps`, { limit });
}

async function cmdStep({ config, positional }: SubcommandOpts): Promise<unknown> {
  const rid = requireArg(positional[1], "workflow-cloudflare inspect step <runId> <stepId>");
  const sid = requireArg(positional[2], "workflow-cloudflare inspect step <runId> <stepId>");
  return inspectFetch(config, `/runs/${rid}/steps/${sid}`);
}

async function cmdEvents({ config, positional, limit, runId }: SubcommandOpts): Promise<unknown> {
  const rid = requireArg(runId || positional[1], "workflow-cloudflare inspect events --run-id <runId>");
  return inspectFetch(config, `/runs/${rid}/events`, { limit });
}

async function cmdHooks({ config, limit, runId }: SubcommandOpts): Promise<unknown> {
  const params: Record<string, string> = { limit };
  if (runId) params.runId = runId;
  return inspectFetch(config, "/hooks", params);
}

async function cmdHook({ config, positional }: SubcommandOpts): Promise<unknown> {
  const id = requireArg(positional[1], "workflow-cloudflare inspect hook <hookId>");
  return inspectFetch(config, `/hooks/${id}`);
}

async function cmdStreams({ config, positional, runId }: SubcommandOpts): Promise<unknown> {
  const rid = requireArg(runId || positional[1], "workflow-cloudflare inspect streams --run-id <runId>");
  return inspectFetch(config, `/runs/${rid}/streams`);
}

async function cmdStorage({ config, positional, runId }: SubcommandOpts): Promise<unknown> {
  const rid = requireArg(runId || positional[1], "workflow-cloudflare inspect storage <runId>");
  return inspectFetch(config, `/runs/${rid}/storage`);
}

const SUBCOMMANDS: Record<string, (opts: SubcommandOpts) => Promise<unknown>> = {
  runs: cmdRuns,
  run: cmdRun,
  steps: cmdSteps,
  step: cmdStep,
  events: cmdEvents,
  hooks: cmdHooks,
  hook: cmdHook,
  streams: cmdStreams,
  storage: cmdStorage,
};

export async function runInspectCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const positional = getPositionalArgs(args);
  const subcommand = positional[0];

  const url = String(flags.url || "");
  const token = String(flags.token || process.env.WORKFLOW_INSPECT_TOKEN || "");
  const json = flags.json === true;
  const limit = String(flags.limit || "20");
  const runId = flags["run-id"] as string | undefined;

  if (!url) {
    console.error("Error: --url is required");
    console.error("Usage: workflow-cloudflare inspect <subcommand> --url <url> [--token <token>]");
    process.exit(1);
  }
  if (!token) {
    console.error("Error: --token is required (or set WORKFLOW_INSPECT_TOKEN env var)");
    process.exit(1);
  }

  const handler = SUBCOMMANDS[subcommand ?? ""];
  if (!handler) {
    console.error(`Unknown inspect subcommand: ${subcommand || "(none)"}`);
    console.error("Available: runs, run, steps, step, events, hooks, hook, streams, storage");
    process.exit(1);
  }

  const config: InspectClientConfig = { url, token };
  try {
    const result = await handler({ config, flags, positional, limit, runId });
    printResult(result, json);
  } catch (err) {
    console.error("Inspect error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
