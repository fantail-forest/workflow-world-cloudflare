/**
 * Polyfill for `node:module` on Cloudflare Workers.
 *
 * The core's runtime/world.ts has a module-level call:
 *   const require = createRequire(join(process.cwd(), 'index.js'));
 *
 * This runs at import time. The polyfill returns a require function that is
 * never actually invoked because the generated Worker entry point calls
 * setWorld() to populate the world cache before any handlers run.
 */

export function createRequire() {
  return function require(id: string): never {
    throw new Error(
      `Dynamic require("${id}") is not supported on Cloudflare Workers. ` +
        "The world should be set via setWorld() before any handlers run.",
    );
  };
}
