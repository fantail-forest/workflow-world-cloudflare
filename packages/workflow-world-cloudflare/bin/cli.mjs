#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function runBuild(flags) {
  const { CloudflareBuilder } = await import('../dist/builder.js');

  const workingDir = flags.dir || process.cwd();
  const appName = flags.name;

  if (!appName) {
    console.error('Error: --name is required');
    console.error(
      'Usage: workflow-cloudflare build --name <app-name> [--format toml|jsonc] [--dir <path>]'
    );
    process.exit(1);
  }

  const builder = new CloudflareBuilder({
    appName,
    buildTarget: 'cloudflare',
    dirs: ['.'],
    workingDir,
    stepsBundlePath: 'dist/step-handler.js',
    workflowsBundlePath: 'dist/flow-handler.js',
    webhookBundlePath: 'dist/webhook-handler.js',
    clientBundlePath: 'dist/client.js',
    wranglerFormat: flags.format || undefined,
    suppressCreateWorkflowsBundleLogs: false,
    suppressCreateWorkflowsBundleWarnings: false,
    suppressCreateWebhookBundleLogs: false,
    suppressCreateManifestLogs: false,
  });

  try {
    await builder.build();
    console.log('Build complete.');
  } catch (err) {
    console.error('Build failed:', err.message || err);
    process.exit(1);
  }
}

async function runDev(flags) {
  const workingDir = flags.dir || process.cwd();
  const format = flags.format || 'toml';

  const serviceConfigExt = format === 'jsonc' ? 'jsonc' : 'toml';
  const serviceConfigPath = resolve(
    workingDir,
    `dist/service-worker/wrangler.${serviceConfigExt}`
  );

  if (!existsSync(serviceConfigPath)) {
    console.error(
      'Error: Service worker config not found. Run `workflow-cloudflare build` first.'
    );
    process.exit(1);
  }

  console.log('Starting workflow service worker...');
  const serviceWorker = spawn(
    'npx',
    ['wrangler', 'dev', '-c', serviceConfigPath, '--port', '8787'],
    {
      cwd: join(workingDir, 'dist/service-worker'),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    }
  );

  serviceWorker.stdout.on('data', (data) => {
    process.stdout.write(`[service] ${data}`);
  });
  serviceWorker.stderr.on('data', (data) => {
    process.stderr.write(`[service] ${data}`);
  });

  // Wait for service worker to start before launching user worker
  await new Promise((resolve) => setTimeout(resolve, 2000));

  console.log('Starting user worker...');
  const userWorker = spawn('npx', ['wrangler', 'dev', '--port', '8788'], {
    cwd: workingDir,
    stdio: 'inherit',
    shell: true,
  });

  function cleanup() {
    serviceWorker.kill();
    userWorker.kill();
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  userWorker.on('exit', (code) => {
    serviceWorker.kill();
    process.exit(code ?? 0);
  });

  serviceWorker.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`Service worker exited with code ${code}`);
      userWorker.kill();
      process.exit(code);
    }
  });
}

async function runInspect(subArgs) {
  const { runInspectCommand } = await import('../dist/inspect-client.js');
  await runInspectCommand(subArgs);
}

function printUsage() {
  console.log(`Usage: workflow-cloudflare <command> [options]

Commands:
  build     Build workflow app for Cloudflare Workers
  dev       Start both workers locally (service + user)
  inspect   Inspect workflow runs, steps, events, hooks, and streams

Build options:
  --name <name>         App name (required) -- namespaces all Cloudflare resources
  --format <toml|jsonc> Wrangler config format (default: auto-detect, then toml)
  --dir <path>          Working directory (default: cwd)

Dev options:
  --dir <path>          Working directory (default: cwd)
  --format <toml|jsonc> Wrangler config format (default: toml)

Inspect options:
  --url <url>           Deployed Worker URL (required)
  --token <token>       Bearer token (or set WORKFLOW_INSPECT_TOKEN env var)
  --json                Output raw JSON
  --limit <n>           Pagination limit (default: 20)
  --run-id <id>         Filter by run ID (for steps, events, streams)

Inspect subcommands:
  inspect runs                   List workflow runs
  inspect run <runId>            Show a specific run
  inspect steps --run-id <id>    List steps for a run
  inspect step <runId> <stepId>  Show a specific step
  inspect events --run-id <id>   List events for a run
  inspect hooks                  List hooks
  inspect hook <hookId>          Show a specific hook
  inspect streams --run-id <id>  List streams for a run`);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

if (command === 'build') {
  const flags = parseFlags(args.slice(1));
  runBuild(flags);
} else if (command === 'dev') {
  const flags = parseFlags(args.slice(1));
  runDev(flags);
} else if (command === 'inspect') {
  runInspect(args.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  printUsage();
  process.exit(1);
}
