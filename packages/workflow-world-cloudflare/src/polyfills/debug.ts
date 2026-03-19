/**
 * No-op polyfill for the `debug` npm package on Cloudflare Workers.
 *
 * The `debug` package dynamically requires `tty` and `supports-color`, which
 * are not available in the Workers runtime. Since console-based debugging is
 * already available via `console.log`, this polyfill provides a compatible
 * but inert implementation.
 */
function debug(_namespace: string) {
  const noop: ((...args: unknown[]) => void) & {
    enabled: boolean;
    log: (...args: unknown[]) => void;
    extend: (ns: string) => typeof noop;
    namespace: string;
  } = Object.assign(function noop() {}, {
    enabled: false,
    log: () => {},
    extend: (_ns: string) => noop,
    namespace: _namespace,
  });
  return noop;
}

debug.enable = (_namespaces: string) => {};
debug.disable = () => "";
debug.enabled = (_namespace: string) => false;
debug.coerce = (val: unknown) => val;

export default debug;
