import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "../../src");

const nodeBuiltins = [
  "assert",
  "buffer",
  "child_process",
  "cluster",
  "crypto",
  "dgram",
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
  "stream",
  "string_decoder",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];
const nodeExternals = nodeBuiltins.flatMap((m) => [m, `node:${m}`]);

await esbuild.build({
  entryPoints: [join(__dirname, "src/worker.ts")],
  outfile: join(__dirname, "dist/worker.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "import"],
  alias: {
    "@vercel/functions": join(srcDir, "polyfills/vercel-functions.ts"),
    "@vercel/queue": join(srcDir, "polyfills/vercel-queue.ts"),
    "cbor-x": "cbor-x/index-no-eval",
    "node:vm": join(srcDir, "polyfills/vm.ts"),
  },
  external: ["cloudflare:workers", "node:async_hooks", ...nodeExternals],
  write: true,
  minify: false,
  logLevel: "info",
});

console.log("Worker built successfully.");
