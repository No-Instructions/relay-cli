import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = process.argv[2] ?? "production";
if (!["production", "staging"].includes(target) || process.argv.length > 4) {
  throw new Error("Usage: node scripts/build-headless.mjs [production|staging] [output-directory]");
}
const outDir = path.resolve(process.argv[3] ?? path.join(root, "dist"));
if (process.env.RELAY_AUTH_URL || process.env.RELAY_API_URL || process.env.RELAY_SERVER_URL) {
  throw new Error("Endpoint overrides are unsupported. Unset RELAY_AUTH_URL, RELAY_API_URL and RELAY_SERVER_URL; select production or staging at build time.");
}
const tld = target === "staging" ? "dev" : "md";
const apiUrl = `https://api.system3.${tld}`;
const authUrl = `https://auth.system3.${tld}`;
const relayManifest = JSON.parse(
  fs.readFileSync(path.join(root, "vendor", "relay", "manifest.json"), "utf8"),
);
const relayVersion = process.env.RELAY_PLUGIN_VERSION ?? relayManifest.version;

const yjsInternalsPlugin = {
  name: "yjs-internals",
  setup(build) {
    build.onResolve({ filter: /^yjs$/ }, () => ({
      path: path.join(root, "node_modules/yjs/src/index.js"),
    }));
    build.onResolve({ filter: /^yjs\/dist\/src\/internals$/ }, () => ({
      path: path.join(root, "node_modules/yjs/src/internals.js"),
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(root, "src/headless/entry.ts")],
  outfile: path.join(outDir, "headless.js"),
  bundle: true,
  banner: {
    js: "import { createRequire as __relayCreateRequire } from 'node:module'; const require = __relayCreateRequire(import.meta.url); globalThis.window ??= globalThis; globalThis.self ??= globalThis; globalThis.EventSource ??= require('eventsource'); Array.prototype.remove ??= function(item) { const index = this.indexOf(item); if (index >= 0) this.splice(index, 1); }; Array.prototype.contains ??= function(item) { return this.includes(item); };",
  },
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [yjsInternalsPlugin],
  tsconfigRaw: {
    compilerOptions: {
      experimentalDecorators: true,
      importsNotUsedAsValues: "remove",
      jsx: "preserve",
      target: "ES2022",
    },
  },
  external: [
    "@napi-rs/keyring",
    "node:child_process",
    "node:crypto",
    "node:events",
    "node:fs",
    "node:fs/promises",
    "node:http",
    "node:http2",
    "node:https",
    "node:net",
    "node:module",
    "node:os",
    "node:path",
    "node:process",
    "node:readline/promises",
    "node:sqlite",
    "node:url",
    "eventsource",
  ],
  alias: {
    obsidian: path.join(root, "src/headless/obsidian-shim.ts"),
  },
  define: {
    RELAY_BUILD_TARGET: JSON.stringify(target),
    API_URL: JSON.stringify(apiUrl),
    AUTH_URL: JSON.stringify(authUrl),
    BUILD_TYPE: JSON.stringify("headless"),
    GIT_TAG: JSON.stringify(relayVersion),
    HEALTH_URL: JSON.stringify(`${apiUrl}/health?version=${encodeURIComponent(relayVersion)}`),
    REPOSITORY: JSON.stringify("No-Instructions/Relay"),
  },
});
console.log(`Relay ${target} build: ${authUrl}, ${apiUrl}`);
