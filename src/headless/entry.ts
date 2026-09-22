import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installBrowserGlobals } from "./browser-globals";
import { HeadlessRelay } from "./HeadlessRelay";
export { buildConfig } from "./build-config";
export {
  clearStoredLogin,
  readStoredLogin,
  writeStoredLogin,
} from "./auth-storage";
export {
  readHsmStoreSmoke,
  readYIndexedDbSmoke,
  writeHsmStoreSmoke,
  writeYIndexedDbSmoke,
} from "./persistence-smoke";
export { createHeadlessLoginManager } from "./HeadlessAuth";
export { FileSystemVault, FileSystemAdapter } from "./FileSystemVault";
export {
  computePositionedChanges,
  rebaseActiveEditorText,
} from "./ActiveEditorSession";
export { TAbstractFile, TFile, TFolder, parseYaml, stringifyYaml } from "./obsidian-shim";
export { extractMapDelta } from "../../vendor/relay/src/SyncStore";
export { ContentAddressedFileStore } from "../../vendor/relay/src/SyncFile";
export { SharedFolder } from "../../vendor/relay/src/SharedFolder";
export * as Y from "yjs";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { options, positional } = parseArgs(rest);
  const folderPath = path.resolve(options.folder ?? positional[0] ?? ".");
  const stateDir = path.resolve(options.stateDir ?? path.join(folderPath, ".relay"));
  await installBrowserGlobals({ storageDbPath: path.join(stateDir, "browser.db") });

  if (command === "self-test") {
    const config = await readRelayConfig(folderPath);
    const runtime = new HeadlessRelay({
      folderGuid: config.folderId,
      folderPath,
      server: config.server,
      relayId: config.relayId,
      stateDir,
    });
    await runtime.start();
    await runtime.waitForStartup();
    try {
      console.log(JSON.stringify(runtime.status(), null, 2));
    } finally {
      await runtime.stop();
    }
    return;
  }

  if (command === "invoke") {
    const handler = options.handler;
    if (!handler) throw new Error("invoke requires --handler <relay:command>");
    const config = await readRelayConfig(folderPath);
    const runtime = new HeadlessRelay({
      folderGuid: config.folderId,
      folderPath,
      server: config.server,
      relayId: config.relayId,
      stateDir,
    });
    await runtime.start();
    await runtime.waitForStartup();
    try {
      const params = options.paramsJson ? JSON.parse(options.paramsJson) : {};
      console.log(await runtime.invoke(handler, params));
    } finally {
      await runtime.stop();
    }
    return;
  }

  throw new Error("Usage: headless self-test|invoke --folder <folder>");
}

async function readRelayConfig(folderPath: string): Promise<{ folderId: string; server?: string; relayId?: string | null }> {
  const text = await fs.readFile(path.join(folderPath, ".relay", "config.toml"), "utf8");
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = JSON.parse(match[2]);
  }
  if (!values.folder_id) throw new Error(`${folderPath} is missing .relay folder_id`);
  return {
    folderId: values.folder_id,
    server: values.server,
    relayId: values.relay_id ?? null,
  };
}

function parseArgs(argv: string[]): { options: Record<string, string | true>; positional: string[] } {
  const options: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawName, inline] = arg.slice(2).split("=", 2);
    if (rawName === "server") {
      throw new Error("--server is unsupported. Endpoints are selected at build time.");
    }
    const key = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = inline ?? argv[++index] ?? true;
  }
  return { options, positional };
}

export { HeadlessRelay, installBrowserGlobals };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error?.stack ?? error?.message ?? String(error));
      process.exit(1);
    });
}
