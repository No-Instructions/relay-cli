import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, existsSync, watch, watchFile, unwatchFile } from "node:fs";
import fs from "node:fs/promises";
import { select } from "@inquirer/prompts";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeNetworkError, requestBinary } from "./network.js";
import { isUnavailablePathError, openSafeFile, resolveSafePath, statSyncEntry } from "./safe-path.js";
import { assertAuthServerMatches, normalizeAuthServer } from "./auth-server.js";

const RELAY_DIR = ".relay";
const CONFIG_FILE = "config.toml";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEADLESS_BUNDLE = path.join(PROJECT_ROOT, "dist", "headless.js");

const VALUE_OPTIONS = new Set([
  "control",
  "folder",
  "format",
  "guid",
  "id",
  "name",
  "params-json",
  "path",
  "provider",
  "relay",
  "repo",
  "scope",
  "state-dir",
  "token",
  "token-file",
  "timeout-seconds",
]);

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (process.env.RELAY_SERVER_URL) {
    throw new Error("RELAY_SERVER_URL is unsupported. Endpoints are selected at build time; unset it and use the production or staging build.");
  }

  if (command === "init") return initCommand(rest);
  if (command === "clone") return cloneCommand(rest);
  if (command === "connect") return connectCommand(rest);
  if (command === "disconnect") return disconnectCommand(rest);
  if (command === "status") return statusCommand(rest);
  if (command === "sync-status") return syncStatusCommand(rest);
  if (command === "deletions") return deletionsCommand(rest);
  if (command === "logging") return loggingCommand(rest);
  if (command === "relays") return relaysCommand(rest);
  if (command === "folders") return foldersCommand(rest);
  if (command === "start") return startCommand(rest);
  if (command === "stop") return stopCommand(rest);
  if (command === "login") return loginCommand(rest);
  if (command === "logout") return logoutCommand(rest);
  if (command === "auth") return authCommand(rest);
  if (command === "debug") return debugCommand(rest);

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`Relay CLI

Usage:
  rmd login [--provider <name>] [--no-open]
  rmd start
  rmd init [path]
  rmd clone [path] --relay <relay> --folder <folder>
  rmd connect [path] --relay <relay>
  rmd disconnect [path]
  rmd status [path]
  rmd sync-status [path]
  rmd deletions [status|send|restore] [path]
  rmd logging [status|enable|disable] [--network]
  rmd relays
  rmd folders
  rmd stop
`);
}

async function initCommand(argv) {
  const { options, positional } = parseArgs(argv);
  const server = (await loadHeadlessBundle()).buildConfig.authUrl;
  const root = path.resolve(positional[0] ?? ".");
  await ensureDirectory(root);
  await createRelayFolder(root, {
    name: options.name ?? (path.basename(root) || "Relay Folder"),
    server,
    relayId: null,
    folderId: randomUUID(),
    indexFiles: true,
  });
  console.log(`Initialized Relay folder: ${root}`);
  if (options.connect) {
    await connectFolder(root, options);
  }
}

async function cloneCommand(argv) {
  const { options, positional } = parseArgs(argv);
  let relayId = options.relay;
  if (!relayId) {
    const relay = await selectRelay(options, "Clone requires --relay when not running interactively.");
    relayId = relay.guid;
  }
  let folderId = options.folder;
  let folderName = null;
  if (!folderId) {
    const folder = await selectRemoteFolder(
      options,
      relayId,
      "Clone requires --folder when not running interactively.",
    );
    folderId = folder.guid;
    folderName = folder.name;
    relayId = relayId ?? folder.relay.guid;
  }

  const root = resolveCloneRoot(positional[0], folderName);
  const server = (await loadHeadlessBundle()).buildConfig.authUrl;
  await ensureDirectory(root);
  await createRelayFolder(root, {
    name: options.name ?? folderName ?? (path.basename(root) || "Relay Folder"),
    server,
    relayId,
    folderId,
    indexFiles: false,
  });
  console.log(`Cloned Relay folder: ${root}`);

  if (!options.noConnect) {
    await connectFolder(root, options);
  }
}

export function resolveCloneRoot(requestedPath, selectedFolderName, cwd = process.cwd()) {
  if (requestedPath) return path.resolve(cwd, requestedPath);
  if (selectedFolderName) return path.resolve(cwd, localCloneDirectoryName(selectedFolderName));
  throw new Error("Clone requires a destination path when --folder is passed non-interactively.");
}

function localCloneDirectoryName(name) {
  const sanitized = String(name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") return "Relay Folder";
  return sanitized;
}

async function connectCommand(argv) {
  const { options, positional } = parseArgs(argv);
  const root = await findRelayFolderRoot(path.resolve(positional[0] ?? "."));
  await connectFolder(root, options);
}

async function relaysCommand(argv) {
  const { options } = parseArgs(argv);
  const result = await invokeRelayCliForUserCommand("relay:relays", {
    format: wantsJsonOutput(options) ? "json" : "text",
    ...(options.id ? { id: options.id } : {}),
    ...(options.refresh === false ? {} : { refresh: "true" }),
  }, options);
  console.log(result);
}

async function foldersCommand(argv) {
  const { options } = parseArgs(argv);
  const repo = options.repo ? path.resolve(options.repo) : await findRelayFolderRootOrNull(process.cwd());
  const result = await invokeRelayCliForUserCommand("relay:folders", {
    format: wantsJsonOutput(options) ? "json" : "text",
    ...(options.scope ? { scope: options.scope } : repo ? {} : { scope: "remote" }),
    ...(options.path ? { path: options.path } : {}),
    ...(options.guid ? { guid: options.guid } : {}),
    ...(options.relay ? { relay: options.relay } : {}),
    ...(options.refresh === false ? {} : { refresh: "true" }),
  }, { ...options, ...(repo ? { repo } : {}) });
  console.log(result);
}

async function disconnectCommand(argv) {
  const { options, positional } = parseArgs(argv);
  const root = await findRelayFolderRoot(path.resolve(positional[0] ?? "."));
  const state = await readDaemonState(options.stateDir);
  const next = state.connected.filter((entry) => entry.path !== root);
  await writeDaemonState(options.stateDir, { ...state, connected: next });
  const control = await liveControlEndpoint(options);
  if (control) {
    await requestControlChecked(control, { type: "refresh" }, options.control);
  }
  console.log(`Stopped syncing: ${root}`);
}

async function statusCommand(argv) {
  const { options, positional } = parseArgs(argv);
  const requested = positional[0] ? path.resolve(positional[0]) : process.cwd();
  const root = await findRelayFolderRootOrNull(requested);
  const state = await readDaemonState(options.stateDir);
  const control = await liveControlEndpoint(options);
  const daemon = control
    ? await liveDaemonStatus(control)
    : await daemonStatus(options.stateDir);
  const folder = root ? await folderStatus(root, state) : null;
  const output = { daemon, folder };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Background sync: ${daemon.running ? "running" : "stopped"}`);
  console.log(`State: ${daemon.stateDir}`);
  console.log(`Connected folders: ${daemon.connected.length}`);
  if (folder) {
    console.log(`Folder: ${folder.path}`);
    console.log(`Relay: ${folder.relayId ?? "(not connected to a Relay)"}`);
    console.log(`Folder ID: ${folder.folderId}`);
    const gate = daemonDeletionGate(daemon, folder.path);
    if (gate?.gated) {
      console.log(
        `Deletion safety: ${gate.paths.length} deletion${gate.paths.length === 1 ? " is" : "s are"} paused for review.`,
      );
      console.log(`Review with: rmd deletions status ${shellQuote(folder.path)}`);
    }
  }
}

async function syncStatusCommand(argv) {
  const { options, positional } = parseArgs(argv);
  const root = await findRelayFolderRoot(path.resolve(positional[0] ?? "."));
  const config = await readConfig(root);
  const control = await liveControlEndpoint(options);
  if (!control) throw new Error("Background sync is not running. Start it with `rmd start`.");
  const response = await requestControl(control, {
    type: "relay_debug",
    method: "getFolderSyncStatus",
    repo: root,
    params: [config.folderId],
  });
  if (!response.ok) throw new Error(response.error ?? "Failed to read sync status.");
  const rows = response.result;
  if (wantsJsonOutput(options)) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No synced files.");
    return;
  }
  for (const row of rows) {
    console.log(`${row.status}\t${row.path}`);
  }
}

async function deletionsCommand(argv) {
  const [subcommand = "status", ...rest] = argv;
  if (!["status", "send", "restore"].includes(subcommand)) {
    throw new Error("Usage: rmd deletions [status|send|restore] [path] [--token <token>]");
  }
  const { options, positional } = parseArgs(rest);
  const root = await findRelayFolderRoot(path.resolve(positional[0] ?? "."));
  const control = await liveControlEndpoint(options);
  if (!control) throw new Error("Background sync is not running. Start it with `rmd start`.");

  if (subcommand === "status") {
    const response = await requestControl(control, {
      type: "deletions_status",
      repo: root,
    });
    if (!response.ok) throw new Error(response.error ?? "Failed to read deletion safety status.");
    if (wantsJsonOutput(options)) {
      console.log(JSON.stringify(response.gate, null, 2));
      return;
    }
    printDeletionGate(response.gate, root);
    return;
  }

  if (!options.token) {
    throw new Error(
      `rmd deletions ${subcommand} requires the token shown by \`rmd deletions status\`.`,
    );
  }
  const response = await requestControl(control, {
    type: "deletions_resolve",
    repo: root,
    decision: subcommand,
    token: options.token,
  });
  if (!response.ok) throw new Error(response.error ?? "Failed to resolve paused deletions.");
  if (response.resolution.result === "stale") {
    throw new Error("The deletion review changed. Run `rmd deletions status` and review the new token.");
  }
  if (wantsJsonOutput(options)) {
    console.log(JSON.stringify(response.resolution, null, 2));
    return;
  }
  if (response.resolution.result === "not-gated") {
    console.log("No deletions are awaiting review.");
  } else if (subcommand === "send") {
    console.log("Sent the reviewed deletions to the shared folder.");
  } else {
    console.log("Kept the shared files and started restoring the local copies.");
  }
}

function printDeletionGate(gate, root) {
  if (!gate.gated) {
    console.log("No deletions are awaiting review.");
    return;
  }
  const count = gate.paths.length;
  console.log(`${count} deletion${count === 1 ? " is" : "s are"} paused for review:`);
  for (const heldPath of gate.paths) console.log(`  ${heldPath}`);
  console.log(`Token: ${gate.token}`);
  console.log(`Send to other devices: rmd deletions send ${shellQuote(root)} --token ${gate.token}`);
  console.log(`Keep and restore files: rmd deletions restore ${shellQuote(root)} --token ${gate.token}`);
}

function daemonDeletionGate(daemon, root) {
  return daemon.headless
    ?.find((entry) => entry.folder === root)
    ?.status?.folders?.[0]?.deletionGate ?? null;
}

async function loggingCommand(argv) {
  const [subcommand = "status", ...rest] = argv;
  const { options } = parseArgs(rest);
  if (!["status", "enable", "disable"].includes(subcommand)) {
    throw new Error("Usage: rmd logging [status|enable|disable] [--network]");
  }

  const control = await liveControlEndpoint(options);
  if (!control) throw new Error("Background sync is not running. Start it with `rmd start`.");

  const response = subcommand === "status"
    ? await requestControl(control, { type: "logging_status" })
    : await requestControl(control, {
        type: "configure_logging",
        logging: loggingPatch(subcommand, options),
      });
  if (!response.ok) throw new Error(response.error ?? "Failed to update logging.");

  if (wantsJsonOutput(options)) {
    console.log(JSON.stringify(response.logging, null, 2));
    return;
  }
  printLoggingStatus(response.logging);
}

function loggingPatch(subcommand, options) {
  if (subcommand === "enable") {
    return {
      debugging: true,
      ...(options.network ? { network: true } : {}),
    };
  }
  return options.network
    ? { network: false }
    : { debugging: false, network: false };
}

function printLoggingStatus(logging) {
  console.log(`Debug logging: ${logging.debugging ? "enabled" : "disabled"}`);
  console.log(`Network logging: ${logging.network ? "enabled" : "disabled"}`);
  console.log(`Settings: ${logging.settingsPath}`);
  if (logging.logFiles?.length) {
    console.log("Log files:");
    for (const file of logging.logFiles) console.log(`  ${file}`);
  }
}

async function startCommand(argv) {
  const { options } = parseArgs(argv);
  if (options.foreground) {
    await runForegroundDaemon(options);
    return;
  }

  const existing = await liveControlEndpoint({ ...options, control: undefined });
  if (existing) {
    console.log("Relay background sync is already running.");
    return;
  }

  const args = [process.argv[1], "start", "--foreground"];
  if (options.stateDir) args.push("--state-dir", options.stateDir);
  if (options.control) args.push("--control", options.control);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await waitForStartedDaemon(options);
  console.log(`Started Relay background sync with pid ${child.pid}`);
}

async function stopCommand(argv) {
  const { options } = parseArgs(argv);
  const control = await liveControlEndpoint(options);
  if (control) {
    await requestControlChecked(control, { type: "shutdown" }, options.control);
    console.log("Stopped Relay background sync.");
    return;
  }

  const paths = daemonPaths(options.stateDir);
  const pid = await readPid(paths.pidFile);
  if (!pid) {
    console.log("Relay background sync is not running.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await fs.rm(paths.pidFile, { force: true });
  console.log(`Stopped Relay background sync with pid ${pid}.`);
}

async function loginCommand(argv) {
  const { options } = parseArgs(argv);
  const server = (await loadHeadlessBundle()).buildConfig.authUrl;
  const token = await suppliedToken(options);
  const stored = token
    ? {
        server,
        token,
        updatedAt: new Date().toISOString(),
      }
    : await loginWithOAuth(options, server);
  const paths = daemonPaths(options.stateDir);
  const storage = await openEncryptedAuthStorage(paths);
  storage.writeStoredLogin(stored);
  await fs.rm(paths.tokensFile, { force: true });
  console.log(`Logged in to ${stored.server}.`);
}

async function logoutCommand(argv) {
  const { options } = parseArgs(argv);
  const paths = daemonPaths(options.stateDir);
  const storage = await openEncryptedAuthStorage(paths);
  storage.clearStoredLogin();
  await fs.rm(paths.tokensFile, { force: true });
  console.log("Logged out.");
}

async function authCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "status") throw new Error("Usage: rmd auth status");
  const { options } = parseArgs(rest);
  const paths = daemonPaths(options.stateDir);
  const storage = await openEncryptedAuthStorage(paths);
  const login = storage.readStoredLogin();
  console.log(login ? `Logged in to ${login.server}.` : "Not logged in.");
}

async function loadHeadlessBundle() {
  if (!existsSync(HEADLESS_BUNDLE)) {
    throw new Error("Headless runtime is not built. Run `npm run build:headless`.");
  }
  return import(pathToFileURL(HEADLESS_BUNDLE).href);
}

async function openEncryptedAuthStorage(paths) {
  const storage = await loadHeadlessBundle();
  await ensureStateDirectory(paths.stateDir);
  await storage.installBrowserGlobals({
    storageDbPath: path.join(paths.stateDir, "browser.db"),
  });
  return storage;
}

async function loginWithOAuth(options, server) {
  const providers = await fetchAuthProviders(server);
  if (providers.length === 0) throw new Error(`No OAuth providers are available on ${server}.`);
  const provider = options.provider
    ? findProvider(providers, options.provider)
    : await selectProvider(providers);
  const redirectUrl = `${server}/api/oauth2-redirect`;
  const authUrl = `${providerAuthUrl(provider)}${redirectUrl}`;
  console.log(`Open this URL to log in with ${provider.name}:`);
  console.log(authUrl);
  if (options.open !== false) openBrowser(authUrl);
  const code = await pollForOAuthCode(server, provider.state, Number(options.timeoutSeconds ?? 30));
  const auth = await exchangeOAuthCode(server, provider, code, redirectUrl);
  return {
    server,
    token: auth.token,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchAuthProviders(server) {
  const url = `${normalizeServer(server)}/api/collections/users/auth-methods`;
  const response = await requestWithContext(url, "Auth provider lookup");
  const body = await parseJsonResponse(response, "auth methods");
  return body.authProviders ?? body.auth_providers ?? [];
}

function findProvider(providers, name) {
  const provider = providers.find((entry) => entry.name === name);
  if (!provider) throw new Error(`OAuth provider not found: ${name}`);
  return provider;
}

async function selectProvider(providers) {
  ensureInteractive("OAuth provider selection requires an interactive terminal. Pass --provider <name>.");
  return await select({
    message: "Select login provider",
    choices: providers.map((provider) => ({
      name: provider.name,
      value: provider,
    })),
  });
}

async function pollForOAuthCode(server, state, timeoutSeconds) {
  const key = String(state ?? "").slice(0, 15);
  if (key.length < 15) throw new Error("OAuth provider state is too short.");
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  const endpoint = `${server}/api/collections/code_exchange/records/${encodeURIComponent(key)}`;
  while (Date.now() < deadline) {
    const response = await requestWithContext(endpoint, "OAuth code polling", { timeoutMs: 10_000 });
    if (response.status === 404) {
      await sleep(1_000);
      continue;
    }
    const body = await parseJsonResponse(response, "OAuth code polling");
    if (body.code) return body.code;
    await sleep(1_000);
  }
  throw new Error(`Auth timeout: timed out after ${timeoutSeconds} seconds.`);
}

async function exchangeOAuthCode(server, provider, code, redirectUrl) {
  const url = `${server}/api/collections/users/auth-with-oauth2`;
  const response = await requestWithContext(url, "OAuth code exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: provider.name,
      code,
      codeVerifier: providerCodeVerifier(provider),
      redirectUrl,
      createData: {},
    }),
  });
  return await parseJsonResponse(response, "OAuth code exchange");
}

async function requestWithContext(url, description, init = {}) {
  try {
    return await requestBinary(url, init);
  } catch (error) {
    throw new Error(describeNetworkError(url, description, error), { cause: error });
  }
}

function providerAuthUrl(provider) {
  return provider.authUrl ?? provider.auth_url ?? "";
}

function providerCodeVerifier(provider) {
  return provider.codeVerifier ?? provider.code_verifier ?? "";
}

async function parseJsonResponse(response, description) {
  const text = typeof response.text === "function" ? await response.text() : response.text;
  if (!response.ok) {
    throw new Error(`${description} failed with status ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function normalizeServer(server) {
  return normalizeAuthServer(server);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url) {
  const command = browserOpenCommand(url);
  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: "ignore",
    shell: command.shell,
  });
  child.on("error", () => {});
  child.unref();
}

export function browserOpenCommand(url, input = {}) {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const configured = firstBrowserCommand(env.BROWSER, platform);
  if (configured) return configuredBrowserOpenCommand(configured, url);
  if (platform === "darwin") return { command: "open", args: [url], shell: false };
  if (platform === "win32") return { command: "cmd", args: ["/C", "start", "", url], shell: false };
  return { command: "xdg-open", args: [url], shell: false };
}

function firstBrowserCommand(browser, platform) {
  const trimmed = String(browser ?? "").trim();
  if (!trimmed) return null;
  const separator = platform === "win32" ? ";" : ":";
  return trimmed.split(separator).map((entry) => entry.trim()).find(Boolean) ?? null;
}

function configuredBrowserOpenCommand(browser, url) {
  if (browser.includes("%s")) {
    return {
      command: browser.replaceAll("%s", shellQuote(url)),
      args: [],
      shell: true,
    };
  }
  return {
    command: `${browser} ${shellQuote(url)}`,
    args: [],
    shell: true,
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function selectRelay(options, nonInteractiveMessage) {
  ensureInteractive(nonInteractiveMessage);
  const relays = await listRelays(options);
  if (relays.length === 0) throw new Error("No relays found for this account.");
  return await selectFromList(
    "Select Relay",
    relays,
    (relay) => `${relay.name} (${relay.role}${relay.owner ? ", owner" : ""})`,
  );
}

async function selectRemoteFolder(options, relayId, nonInteractiveMessage) {
  ensureInteractive(nonInteractiveMessage);
  const folders = await listRemoteFolders(options, relayId);
  if (folders.length === 0) {
    throw new Error(relayId ? `No folders found for Relay ${relayId}.` : "No folders found.");
  }
  return await selectFromList(
    "Select Folder",
    folders,
    (folder) => `${folder.name} (${folder.relay.name})`,
  );
}

function ensureInteractive(message) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(message);
  }
}

async function selectFromList(title, items, label) {
  return await select({
    message: title,
    choices: items.map((item) => ({
      name: label(item),
      value: item,
    })),
  });
}

async function listRelays(options) {
  const result = await invokeRelayCliForUserCommand("relay:relays", {
    format: "json",
    refresh: "true",
  }, options);
  return JSON.parse(result);
}

async function listRemoteFolders(options, relayId) {
  const result = await invokeRelayCliForUserCommand("relay:folders", {
    format: "json",
    refresh: "true",
    scope: "remote",
    ...(relayId ? { relay: relayId } : {}),
  }, options);
  return JSON.parse(result).remote;
}

async function invokeRelayCliForUserCommand(command, params, options) {
  const repo = options.repo
    ? path.resolve(options.repo)
    : await findRelayFolderRootOrNull(process.cwd());
  const control = await liveControlEndpoint(options);
  if (control) {
    const response = await requestControl(control, {
      type: "relay_cli",
      command,
      repo,
      params,
    });
    if (response.ok) return response.result;
    if (options.control && response.error !== "No headless Relay runtime is running.") {
      throw new Error(response.error ?? "Relay CLI request failed.");
    }
  }
  return await invokeRelayCliEphemeral(command, params, options);
}

async function invokeRelayCliEphemeral(command, params, options) {
  if (!existsSync(HEADLESS_BUNDLE)) {
    throw new Error("Headless runtime is not built. Run `npm run build:headless`.");
  }
  const paths = daemonPaths(options.stateDir);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cli-query-"));
  let runtime = null;
  try {
    const {
      HeadlessRelay,
      installBrowserGlobals,
      readStoredLogin,
    } = await import(pathToFileURL(HEADLESS_BUNDLE).href);
    await installBrowserGlobals({ storageDbPath: path.join(paths.stateDir, "browser.db") });
    const login = readStoredLogin();
    if (!login?.token) {
      throw new Error("Not logged in. Run `rmd login` first.");
    }
    runtime = new HeadlessRelay({
      folderGuid: randomUUID(),
      folderPath: scratch,
      server: login.server,
      relayId: null,
      stateDir: paths.stateDir,
    });
    await runtime.start();
    return await runtime.invoke(command, params);
  } finally {
    await runtime?.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function wantsJsonOutput(options) {
  return options.json || options.format === "json";
}

async function debugCommand(argv) {
  const [subcommand, method, ...rest] = argv;
  if (!method || (subcommand !== "relay-debug" && subcommand !== "relay-cli")) {
    throw new Error("Usage: rmd debug relay-debug <method> --control <endpoint>\n       rmd debug relay-cli <command> --control <endpoint>");
  }
  const { options } = parseArgs(rest);
  if (!options.control) throw new Error(`debug ${subcommand} requires --control.`);
  const params = options.paramsJson
    ? JSON.parse(options.paramsJson)
    : subcommand === "relay-debug"
      ? []
      : {};
  const request = subcommand === "relay-debug"
    ? {
        type: "relay_debug",
        method,
        repo: options.repo ? path.resolve(options.repo) : null,
        params,
      }
    : {
        type: "relay_cli",
        command: method,
        repo: options.repo ? path.resolve(options.repo) : null,
        params,
      };
  const response = await requestControl(await liveControlEndpoint(options), {
    ...request,
  });
  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
  } else {
    console.log(JSON.stringify(response));
  }
}

async function createRelayFolder(root, input) {
  const relayDir = path.join(root, RELAY_DIR);
  if (existsSync(relayDir)) throw new Error(`${relayDir} already exists.`);
  await fs.mkdir(relayDir, { recursive: true });
  await fs.mkdir(path.join(relayDir, "logs"), { recursive: true });

  const config = {
    formatVersion: 1,
    folderId: input.folderId,
    relayId: input.relayId,
    server: input.server,
    name: input.name,
  };
  await writeConfig(root, config);
  const files = input.indexFiles ? await scanMarkdownFiles(root) : [];
  initDatabase(path.join(relayDir, "relay.db"), config, files);
}

async function connectFolder(root, options) {
  const config = await readConfig(root);
  const server = (await loadHeadlessBundle()).buildConfig.authUrl;
  assertAuthServerMatches(config.server, server);
  let nextConfig = config;
  const authoritative = !config.relayId;
  if (!config.relayId) {
    const relayId = options.relay
      ?? (await selectRelay(
        options,
        "This folder is not connected to a Relay. Pass --relay <relay-guid>.",
      )).guid;
    nextConfig = {
      ...config,
      relayId,
      server,
    };
    await writeConfig(root, nextConfig);
    updateDatabaseRelay(path.join(root, RELAY_DIR, "relay.db"), nextConfig);
  }

  const state = await readDaemonState(options.stateDir);
  const entry = {
    path: root,
    relayId: nextConfig.relayId,
    folderId: nextConfig.folderId,
    server: nextConfig.server,
    name: nextConfig.name,
    authoritative,
    connectedAt: new Date().toISOString(),
  };
  const connected = state.connected.filter((item) => item.path !== root);
  connected.push(entry);
  await writeDaemonState(options.stateDir, { ...state, connected });
  console.log(`Syncing folder: ${root}`);

  const control = await liveControlEndpoint(options);
  if (control) {
    await requestControlChecked(control, { type: "refresh" }, options.control);
  } else if (!(await daemonStatus(options.stateDir)).running) {
    console.log("Background sync is not running. Start it with `rmd start`.");
  }
}

function initDatabase(dbPath, config, files) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS folder (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      folder_id TEXT NOT NULL,
      relay_id TEXT,
      server TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO folder (id, folder_id, relay_id, server, name, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      folder_id = excluded.folder_id,
      relay_id = excluded.relay_id,
      server = excluded.server,
      name = excluded.name,
      updated_at = excluded.updated_at
  `).run(config.folderId, config.relayId, config.server, config.name, now);
  const insert = db.prepare(`
    INSERT INTO files (path, file_id, sha256, size, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const file of files) {
    insert.run(file.path, randomUUID(), file.sha256, file.size, now);
  }
  db.close();
}

function updateDatabaseRelay(dbPath, config) {
  const db = new DatabaseSync(dbPath);
  db.prepare(`
    UPDATE folder
    SET relay_id = ?, server = ?, updated_at = ?
    WHERE id = 1
  `).run(config.relayId, config.server, new Date().toISOString());
  db.close();
}

async function scanMarkdownFiles(root) {
  const results = [];
  await scanDir(root, root, results);
  results.sort((left, right) => left.path.localeCompare(right.path));
  return results;
}

async function scanDir(root, dir, results) {
  const entries = await fs.readdir(resolveSafePath(root, path.relative(root, dir)), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === RELAY_DIR) continue;
    const fullPath = path.join(dir, entry.name);
    let stat;
    try {
      stat = statSyncEntry(root, path.relative(root, fullPath));
    } catch (error) {
      if (isUnavailablePathError(error)) continue;
      throw error;
    }
    if (stat.isDirectory()) {
      await scanDir(root, fullPath, results);
      continue;
    }
    if (!stat.isFile() || path.extname(entry.name) !== ".md") continue;
    const file = await openSafeFile(root, path.relative(root, fullPath), constants.O_RDONLY);
    let bytes;
    try {
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    results.push({
      path: `/${path.relative(root, fullPath).replaceAll(path.sep, "/")}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
}

async function folderStatus(root, state) {
  const config = await readConfig(root);
  const connected = state.connected.some((entry) => entry.path === root);
  return {
    path: root,
    connected,
    relayId: config.relayId,
    folderId: config.folderId,
    server: config.server,
    name: config.name,
  };
}

async function runForegroundDaemon(options) {
  const paths = daemonPaths(options.stateDir);
  await ensureStateDirectory(paths.stateDir);
  await fs.writeFile(paths.pidFile, `${process.pid}\n`, "utf8");
  const runtime = await createDaemonRuntime(options.stateDir);
  const controlEndpoint = options.control ?? defaultControlEndpoint(paths) ?? "tcp://127.0.0.1:0";

  let server = null;
  let shuttingDown = false;
  const cleanup = async () => {
    await runtime.close();
    await fs.rm(paths.pidFile, { force: true });
    await fs.rm(paths.controlFile, { force: true });
    server?.close();
  };
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanup();
    process.exit(0);
  };

  if (controlEndpoint) {
    server = await startControlServer(controlEndpoint, runtime, shutdown);
    await writeJson(paths.controlFile, { endpoint: server.endpoint, pid: process.pid, authToken: server.authToken });
  }

  if (options.control) {
    console.log(JSON.stringify({
      type: "rmd.daemon.ready",
      control: server.endpoint,
      stateDir: paths.stateDir,
    }));
  } else {
    console.log(`Relay background sync running. State: ${paths.stateDir}`);
    if (server) console.log(`Control: ${server.endpoint}`);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  await new Promise(() => {});
}

export function createSerializedTaskRunner(task) {
  let tail = Promise.resolve();
  let closed = false;
  return {
    run() {
      const next = tail
        .catch(() => {})
        .then(() => {
          if (closed) return;
          return task();
        });
      tail = next;
      return next;
    },
    async close() {
      closed = true;
      await tail.catch(() => {});
    },
  };
}

async function createDaemonRuntime(stateDir) {
  const runtime = {
    stateDir,
    headless: new Map(),
    headlessErrors: new Map(),
    watchers: new Map(),
    recentEvents: [],
    refreshTimer: null,
    refreshRunner: null,
    async refreshOnce() {
      const state = await readDaemonState(stateDir);
      const connectedPaths = new Set(state.connected.map((entry) => entry.path));
      for (const [folderPath, watcherSet] of runtime.watchers) {
        if (!connectedPaths.has(folderPath)) {
          closeWatcherSet(watcherSet);
          runtime.watchers.delete(folderPath);
        }
      }
      for (const [folderPath, relayRuntime] of runtime.headless) {
        if (!connectedPaths.has(folderPath)) {
          await relayRuntime.stop();
          runtime.headless.delete(folderPath);
          runtime.headlessErrors.delete(folderPath);
        }
      }
      for (const folder of state.connected) {
        if (!runtime.headless.has(folder.path)) {
          try {
            const relayRuntime = await startHeadlessRelayRuntime(folder, stateDir);
            runtime.headless.set(folder.path, relayRuntime);
            runtime.headlessErrors.delete(folder.path);
          } catch (error) {
            runtime.headlessErrors.set(folder.path, error.message);
            console.error(`Relay headless runtime failed for ${folder.path}: ${error.message}`);
          }
        }
        if (!runtime.watchers.has(folder.path)) {
          runtime.watchers.set(folder.path, await watchRelayFolder(folder.path, (event) => {
            runtime.recentEvents.push({
              folder: folder.path,
              ...event,
              observedAt: new Date().toISOString(),
            });
            if (runtime.recentEvents.length > 200) {
              runtime.recentEvents.splice(0, runtime.recentEvents.length - 200);
            }
            const relayRuntime = runtime.headless.get(folder.path);
            relayRuntime?.handleFilesystemEvent(event).catch((error) => {
              runtime.headlessErrors.set(folder.path, error.message);
              console.error(`Relay filesystem event failed for ${folder.path}: ${error.message}`);
            });
          }));
        }
      }
    },
    refresh() {
      return runtime.refreshRunner.run();
    },
    async status() {
      const status = await daemonStatus(stateDir);
      return {
        ...status,
        logging: await runtime.loggingStatus(),
        headless: [...runtime.headless.entries()].map(([folderPath, relayRuntime]) => ({
          folder: folderPath,
          status: relayRuntime.status(),
        })),
        headlessErrors: Object.fromEntries(runtime.headlessErrors),
        watching: [...runtime.watchers.keys()],
        recentEvents: [...runtime.recentEvents],
      };
    },
    async invokeRelayDebug(repo, method, params) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return await relayRuntime.invokeDebug(method, Array.isArray(params) ? params : []);
    },
    async invokeRelayCli(repo, command, params) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return await relayRuntime.invoke(command, params && typeof params === "object" ? params : {});
    },
    async openActiveEditor(repo, input) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return await relayRuntime.openActiveEditor(input ?? {});
    },
    activeEditorFrame(repo, sessionId) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return relayRuntime.activeEditorFrame(sessionId);
    },
    applyActiveEditor(repo, sessionId, input) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return relayRuntime.applyActiveEditor(sessionId, input ?? {});
    },
    async closeActiveEditor(repo, sessionId) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      await relayRuntime.closeActiveEditor(sessionId);
    },
    async deletionGateStatus(repo) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return relayRuntime.deletionGateStatus();
    },
    async resolveDeletionGate(repo, decision, token) {
      const relayRuntime = selectHeadlessRuntime(runtime.headless, repo);
      if (!relayRuntime) throw new Error("No headless Relay runtime is running.");
      return relayRuntime.resolveDeletionGate(decision, token);
    },
    async loggingStatus() {
      const settings = await readPluginSettings(stateDir);
      return {
        debugging: settings.debugging === true,
        network: settings.enableNetworkLogging === true,
        settingsPath: daemonPluginDataPath(stateDir),
        logFiles: [...runtime.headless.values()].map((relayRuntime) => relayRuntime.loggingStatus().logPath),
      };
    },
    async configureLogging(logging) {
      await updatePluginSettings(stateDir, (settings) => applyLoggingPatch(settings, logging));
      for (const relayRuntime of runtime.headless.values()) {
        await relayRuntime.configureLogging(logging);
      }
      return await runtime.loggingStatus();
    },
    async close() {
      if (runtime.refreshTimer) clearInterval(runtime.refreshTimer);
      await runtime.refreshRunner.close();
      for (const watcherSet of runtime.watchers.values()) {
        closeWatcherSet(watcherSet);
      }
      runtime.watchers.clear();
      for (const relayRuntime of runtime.headless.values()) {
        await relayRuntime.stop();
      }
      runtime.headless.clear();
    },
  };
  runtime.refreshRunner = createSerializedTaskRunner(() => runtime.refreshOnce());

  await runtime.refresh();
  runtime.refreshTimer = setInterval(() => {
    runtime.refresh().catch((error) => {
      console.error(`Relay background sync refresh failed: ${error.message}`);
    });
  }, 2_000);
  return runtime;
}

function selectHeadlessRuntime(runtimes, repo) {
  if (!repo) return runtimes.values().next().value ?? null;
  const requested = path.resolve(repo);
  for (const [folderPath, relayRuntime] of runtimes) {
    if (requested === folderPath || requested.startsWith(`${folderPath}${path.sep}`)) {
      return relayRuntime;
    }
  }
  return null;
}

async function startHeadlessRelayRuntime(folder, stateDir) {
  if (!existsSync(HEADLESS_BUNDLE)) {
    throw new Error("Headless runtime is not built. Run `npm run build:headless`.");
  }
  const paths = daemonPaths(stateDir);
  const { HeadlessRelay, installBrowserGlobals } = await import(pathToFileURL(HEADLESS_BUNDLE).href);
  await installBrowserGlobals({ storageDbPath: path.join(paths.stateDir, "browser.db") });
  const relayRuntime = new HeadlessRelay({
    folderGuid: folder.folderId,
    folderPath: folder.path,
    server: folder.server,
    relayId: folder.relayId,
    authoritative: folder.authoritative === true,
    stateDir: paths.stateDir,
  });
  await relayRuntime.start();
  await relayRuntime.waitForStartup();
  return relayRuntime;
}

export async function watchRelayFolder(root, onEvent) {
  resolveSafePath(root);
  const watcherSet = new Set();
  const watchedPaths = new Map();
  const pendingChanges = new Map();
  const pendingRenames = new Set();
  const knownEntries = new Map();
  let pendingRenameTimer = null;
  let closed = false;

  watcherSet.add({
    close() {
      closed = true;
      for (const timer of pendingChanges.values()) clearTimeout(timer);
      pendingChanges.clear();
      if (pendingRenameTimer) clearTimeout(pendingRenameTimer);
      pendingRenameTimer = null;
      pendingRenames.clear();
    },
  });

  function emitEvent(event) {
    if (closed) return;
    if (event.type === "rename") {
      queueRenameEvent(event.path);
      return;
    }
    if (event.type !== "change") {
      onEvent(event);
      return;
    }
    const previous = pendingChanges.get(event.path);
    if (previous) clearTimeout(previous);
    pendingChanges.set(event.path, setTimeout(() => {
      pendingChanges.delete(event.path);
      describeLocalEntry(root, event.path)
        .then((entry) => {
          if (entry) {
            knownEntries.set(event.path, entry);
          } else {
            // The path vanished between the watcher event and this stat (a
            // rename can race the change debounce). Keep the entry so rename
            // inference diffs the disappearance instead of forgetting it.
            queueRenameEvent(event.path);
          }
        })
        .catch((error) => {
          console.error(`Relay filesystem change tracking failed: ${error.message}`);
        })
        .finally(() => {
          if (!closed) onEvent(event);
        });
    }, 100));
  }

  let renameFlushInFlight = null;
  let renameFlushQueued = false;

  function runRenameFlush() {
    if (renameFlushInFlight) {
      renameFlushQueued = true;
      return;
    }
    renameFlushInFlight = flushRenameEvents()
      .catch((error) => {
        console.error(`Relay filesystem rename inference failed: ${error.message}`);
      })
      .finally(() => {
        renameFlushInFlight = null;
        if (renameFlushQueued) {
          renameFlushQueued = false;
          runRenameFlush();
        }
      });
  }

  function queueRenameEvent(localPath) {
    if (closed) return;
    pendingRenames.add(localPath);
    if (pendingRenameTimer) clearTimeout(pendingRenameTimer);
    pendingRenameTimer = setTimeout(() => {
      pendingRenameTimer = null;
      runRenameFlush();
    }, 150);
  }

  async function flushRenameEvents() {
    const paths = new Set(pendingRenames);
    pendingRenames.clear();

    const previousEntries = new Map(knownEntries);
    const currentEntries = await snapshotKnownTree(root);
    await refreshWatchers();
    if (closed) return;
    knownEntries.clear();
    for (const [localPath, entry] of currentEntries) {
      knownEntries.set(localPath, entry);
    }

    const creates = [];
    const deletes = [];
    const unresolved = [];

    for (const [localPath, entry] of previousEntries) {
      if (!currentEntries.has(localPath)) deletes.push({ path: localPath, entry });
    }
    for (const [localPath, entry] of currentEntries) {
      if (!previousEntries.has(localPath)) {
        creates.push({ path: localPath, entry });
      }
    }
    const usedCreates = new Set();
    for (const deleted of deletes) {
      const matches = creates.flatMap((created, index) =>
        !usedCreates.has(index) && entriesMatchForMove(created.entry, deleted.entry) ? [index] : []);
      const siblings = matches.filter((index) =>
        path.posix.dirname(creates[index].path) === path.posix.dirname(deleted.path));
      // Aliases can expose the same inode at several paths. Prefer a rename
      // within the same logical parent; do not arbitrarily cross-wire aliases.
      const matchIndex = siblings.length === 1 ? siblings[0] : matches.length === 1 ? matches[0] : -1;
      if (matchIndex >= 0) {
        usedCreates.add(matchIndex);
        onEvent({ type: "move", path: creates[matchIndex].path, oldPath: deleted.path });
      } else {
        onEvent({ type: "rename", path: deleted.path });
      }
    }

    const coveredPaths = new Set();
    creates.forEach((created, index) => {
      if (!usedCreates.has(index)) {
        onEvent({ type: "rename", path: created.path });
      }
      coveredPaths.add(created.path);
    });
    for (const deleted of deletes) coveredPaths.add(deleted.path);
    // Safety net: a queued path that the snapshot diff classified as unchanged
    // can still be stale (identity churn, interleaved internal writes). Emit a
    // per-path reconcile so the vault re-checks it against live disk state.
    for (const localPath of paths) {
      if (coveredPaths.has(localPath)) continue;
      const entry = await describeLocalEntry(root, localPath);
      if (entry) knownEntries.set(localPath, entry);
      else knownEntries.delete(localPath);
      onEvent({ type: "rename", path: localPath });
    }
    for (const localPath of paths) {
      if (
        previousEntries.has(localPath) &&
        currentEntries.has(localPath) &&
        entryVersion(previousEntries.get(localPath)) !== entryVersion(currentEntries.get(localPath))
      ) {
        unresolved.push({ type: "rename", path: localPath });
      }
    }
    unresolved.forEach(onEvent);
  }

  async function refreshWatchers() {
    const needed = new Set();
    function keep(key, version, create) {
      if (closed) return;
      needed.add(key);
      const previous = watchedPaths.get(key);
      if (previous?.version === version) return;
      if (previous) {
        previous.watcher.close();
        watcherSet.delete(previous.watcher);
        watchedPaths.delete(key);
      }
      const watcher = create();
      watchedPaths.set(key, { version, watcher });
      watcherSet.add(watcher);
    }

    async function visit(fullPath) {
      if (closed || isRelayInternalPath(root, fullPath)) return;
      try {
        const relative = path.relative(root, fullPath);
        resolveSafePath(root, relative);
        const link = await fs.lstat(fullPath);
        const localPath = toLocalFolderPath(root, fullPath);
        if (link.isSymbolicLink()) {
          // A watch on the containing directory cannot see writes to an
          // external file target. Stat polling also survives atomic target
          // replacement and notices a broken link becoming usable again.
          keep(`link:${fullPath}`, "link", () => {
            const listener = (current, previous) => {
              const sameFile = current.isFile() && previous.isFile() &&
                current.dev === previous.dev && current.ino === previous.ino;
              emitEvent({ type: sameFile ? "change" : "rename", path: localPath });
            };
            watchFile(fullPath, { interval: 500 }, listener);
            return { close: () => unwatchFile(fullPath, listener) };
          });
        }
        const stat = statSyncEntry(root, relative);
        if (!stat.isDirectory()) return;
        const physical = await fs.realpath(fullPath);
        keep(`dir:${fullPath}`, `${physical}:${stat.dev}:${stat.ino}`, () => {
          const watcher = watch(fullPath, { persistent: true }, (eventType, filename) => {
            if (!filename) {
              emitEvent({ type: "rename", path: localPath });
              return;
            }
            const child = path.join(fullPath, filename.toString());
            if (isRelayInternalPath(root, child)) return;
            emitEvent({ type: eventType, path: toLocalFolderPath(root, child) });
          });
          watcher.on("error", () => emitEvent({ type: "rename", path: localPath }));
          return watcher;
        });
        const children = await fs.readdir(fullPath, { withFileTypes: true });
        for (const child of children) {
          if (child.name === RELAY_DIR) continue;
          if (child.isDirectory() || child.isSymbolicLink()) await visit(path.join(fullPath, child.name));
        }
      } catch (error) {
        if (!isUnavailablePathError(error)) throw error;
      }
    }

    await visit(path.resolve(root));
    for (const [key, entry] of watchedPaths) {
      if (needed.has(key)) continue;
      entry.watcher.close();
      watcherSet.delete(entry.watcher);
      watchedPaths.delete(key);
    }
  }

  async function watchRootParent() {
    const resolvedRoot = path.resolve(root);
    const parent = path.dirname(resolvedRoot);
    const rootName = path.basename(resolvedRoot);
    const watcher = watch(parent, { persistent: true }, (eventType, filename) => {
      if (!filename || filename.toString() !== rootName) return;
      emitEvent({ type: eventType, path: "/" });
    });
    watcherSet.add(watcher);
  }

  try {
    for (const [localPath, entry] of await snapshotKnownTree(root)) {
      knownEntries.set(localPath, entry);
    }
    await watchRootParent();
    await refreshWatchers();
    return watcherSet;
  } catch (error) {
    closeWatcherSet(watcherSet);
    throw error;
  }
}

async function snapshotKnownTree(root) {
  const entries = new Map();
  await index(root);
  return entries;

  async function index(dir) {
    let dirents;
    try {
      dirents = await fs.readdir(resolveSafePath(root, path.relative(root, dir)), { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(dirents.map(async (dirent) => {
      if (dirent.name === RELAY_DIR) return;
      const fullPath = path.join(dir, dirent.name);
      const localPath = toLocalFolderPath(root, fullPath);
      const description = await describeLocalEntry(root, localPath);
      if (description) entries.set(localPath, description);
      if (description?.kind === "folder") await index(fullPath);
    }));
  }
}

async function describeLocalEntry(root, localPath) {
  try {
    const fullPath = localPathToFullPath(root, localPath);
    const stat = statSyncEntry(root, path.relative(root, fullPath));
    if (!stat.isFile() && !stat.isDirectory()) return null;
    // Renaming a link moves the link's identity, not its target's identity.
    const link = await fs.lstat(fullPath);
    const identity = link.isSymbolicLink() ? link : stat;
    return {
      kind: stat.isDirectory() ? "folder" : "file",
      identity: identity.dev && identity.ino ? `${identity.dev}:${identity.ino}` : null,
      mtimeMs: stat.mtimeMs,
      size: stat.isFile() ? stat.size : 0,
    };
  } catch (error) {
    if (isUnavailablePathError(error)) return null;
    throw error;
  }
}

function entriesMatchForMove(left, right) {
  if (left.kind !== right.kind) return false;
  if (left.identity && right.identity) return left.identity === right.identity;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function entryVersion(entry) {
  return `${entry.kind}:${entry.identity ?? ""}:${entry.size}:${entry.mtimeMs}`;
}

function closeWatcherSet(watcherSet) {
  for (const watcher of watcherSet) {
    watcher.close();
  }
  watcherSet.clear();
}

function isRelayInternalPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === RELAY_DIR || relative.startsWith(`${RELAY_DIR}${path.sep}`);
}

function toLocalFolderPath(root, fullPath) {
  const relative = path.relative(root, fullPath).replaceAll(path.sep, "/");
  return relative ? `/${relative}` : "/";
}

function localPathToFullPath(root, localPath) {
  const relative = localPath.replace(/^\/+/, "").split("/").filter(Boolean);
  return path.join(root, ...relative);
}

async function startControlServer(endpoint, runtime, shutdown) {
  const parsed = parseControlEndpoint(endpoint);
  if (parsed.kind === "unix") {
    await prepareUnixSocket(parsed.path);
  }

  const authToken = parsed.kind === "tcp" ? randomBytes(32).toString("hex") : undefined;
  const server = net.createServer((socket) => {
    let buffer = "";
    let receivedBytes = 0;
    let processing = false;
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    const reply = (response, onSent) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`, onSent);
    };
    socket.on("data", (chunk) => {
      if (processing) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > 1024 * 1024) {
        processing = true;
        reply({ ok: false, error: "Control request exceeds 1 MiB." });
        return;
      }
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      processing = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
      } catch {
        reply({ ok: false, error: "Invalid control JSON." });
        return;
      }
      if (!request || Array.isArray(request) || typeof request !== "object" || typeof request.type !== "string") {
        reply({ ok: false, error: "Invalid control request." });
        return;
      }
      if (authToken && !validControlToken(request.authToken, authToken)) {
        reply({ ok: false, error: "Unauthorized control request." });
        return;
      }
      socket.setTimeout(30_000);
      Promise.resolve().then(() => handleControlRequest(request, runtime)).then((response) => {
        reply(response, () => {
          if (response.ok && request.type === "shutdown") void shutdown();
        });
      }).catch((error) => reply({ ok: false, error: error.message }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (parsed.kind === "tcp") {
      server.listen(parsed.port, parsed.host, resolve);
    } else {
      server.listen(parsed.path, resolve);
    }
  });
  if (parsed.kind === "unix") await fs.chmod(parsed.path, 0o600);
  const address = server.address();
  const endpointText = typeof address === "string"
    ? formatUnixEndpoint(address)
    : `tcp://${address.address}:${address.port}`;
  return {
    close: () => {
      server.close();
      if (parsed.kind === "unix") {
        fs.rm(parsed.path, { force: true }).catch(() => {});
      }
    },
    endpoint: endpointText,
    authToken,
  };
}

function validControlToken(provided, expected) {
  if (typeof provided !== "string" || !/^[a-f0-9]{64}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

async function handleControlRequest(request, runtime) {
  if (request.type === "status") {
    return { ok: true, status: await runtime.status() };
  }
  if (request.type === "refresh") {
    await runtime.refresh();
    return { ok: true };
  }
  if (request.type === "logging_status") {
    return { ok: true, logging: await runtime.loggingStatus() };
  }
  if (request.type === "configure_logging") {
    return { ok: true, logging: await runtime.configureLogging(request.logging ?? {}) };
  }
  if (request.type === "shutdown") {
    return { ok: true };
  }
  if (request.type === "relay_debug") {
    try {
      const result = await runtime.invokeRelayDebug(
        request.repo,
        request.method,
        request.params,
      );
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "relay_cli") {
    try {
      const result = await runtime.invokeRelayCli(
        request.repo,
        request.command,
        request.params,
      );
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "deletions_status") {
    try {
      return { ok: true, gate: await runtime.deletionGateStatus(request.repo) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "deletions_resolve") {
    try {
      if (!["send", "restore"].includes(request.decision)) {
        return { ok: false, error: "Deletion decision must be send or restore." };
      }
      if (typeof request.token !== "string" || !request.token) {
        return { ok: false, error: "Deletion resolution requires a review token." };
      }
      return {
        ok: true,
        resolution: await runtime.resolveDeletionGate(
          request.repo,
          request.decision,
          request.token,
        ),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "active_editor_open") {
    try {
      return {
        ok: true,
        frame: await runtime.openActiveEditor(request.repo, {
          path: request.path,
          user: request.user,
        }),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "active_editor_frame") {
    try {
      return {
        ok: true,
        frame: runtime.activeEditorFrame(request.repo, request.sessionId),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "active_editor_apply") {
    try {
      return {
        ok: true,
        result: runtime.applyActiveEditor(
          request.repo,
          request.sessionId,
          {
            baseText: request.baseText,
            desiredText: request.desiredText,
            cursor: request.cursor,
            selection: request.selection,
          },
        ),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  if (request.type === "active_editor_close") {
    try {
      await runtime.closeActiveEditor(request.repo, request.sessionId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  return { ok: false, error: `Unknown control request: ${request.type}` };
}

async function liveDaemonStatus(endpoint) {
  const response = await requestControl(endpoint, { type: "status" });
  if (!response.ok) throw new Error(response.error ?? "Failed to read live daemon status.");
  return response.status;
}

async function liveControlEndpoint(options) {
  const paths = daemonPaths(options.stateDir);
  const stored = await readJsonOrNull(paths.controlFile);
  const connectionFor = (endpoint) => ({
    endpoint,
    authToken: stored?.endpoint === endpoint ? stored.authToken : undefined,
  });
  if (options.control) return connectionFor(options.control);
  const endpoints = [stored?.endpoint, defaultControlEndpoint(paths)].filter(Boolean);
  for (const endpoint of endpoints) {
    try {
      const connection = connectionFor(endpoint);
      const response = await requestControl(connection, { type: "status" });
      if (response.ok) return connection;
    } catch {}
  }
  return null;
}

async function waitForStartedDaemon(options) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const control = await liveControlEndpoint({ ...options, control: undefined });
    if (control) return control;
    await sleep(100);
  }
  const status = await daemonStatus(options.stateDir);
  if (status.running) return null;
  throw new Error("Relay background sync did not start.");
}

async function requestControlChecked(endpoint, request, explicit) {
  try {
    const response = await requestControl(endpoint, request);
    if (!response.ok) throw new Error(response.error ?? "Daemon control request failed.");
    return response;
  } catch (error) {
    if (explicit) throw error;
    return null;
  }
}

async function daemonStatus(stateDir) {
  const paths = daemonPaths(stateDir);
  const state = await readDaemonState(stateDir);
  const pid = await readPid(paths.pidFile);
  return {
    stateDir: paths.stateDir,
    running: pid ? isProcessRunning(pid) : false,
    pid,
    socketPath: paths.socketFile,
    connected: state.connected,
  };
}

async function requestControl(connection, request) {
  const { endpoint, authToken } = typeof connection === "string" ? { endpoint: connection } : connection;
  const parsed = parseControlEndpoint(endpoint);
  if (parsed.kind === "tcp" && !authToken) {
    throw new Error("TCP control credentials unavailable. Pass --state-dir for the daemon that owns this endpoint.");
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const socket = parsed.kind === "tcp"
      ? net.createConnection({ host: parsed.host, port: parsed.port })
      : net.createConnection(parsed.path);
    let buffer = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(30_000, () => {
      finish(reject, new Error(`Timed out waiting for ${endpoint}`));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.setEncoding("utf8");
    socket.on("end", () => finish(reject, new Error("Daemon closed the control connection without a response.")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        finish(reject, new Error("Control response exceeds 16 MiB."));
        return;
      }
      if (!buffer.includes("\n")) return;
      try {
        finish(resolve, JSON.parse(buffer.split("\n")[0]));
      } catch {
        finish(reject, new Error("Invalid daemon control response."));
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ ...request, authToken })}\n`);
    });
  });
}

function parseControlEndpoint(value) {
  const url = new URL(value);
  if (url.protocol === "tcp:") {
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("TCP control endpoint must be loopback.");
    }
    return {
      kind: "tcp",
      host: url.hostname,
      port: Number(url.port || "0"),
    };
  }
  if (url.protocol === "unix:") {
    if (!url.pathname) throw new Error("Unix control endpoint requires a socket path.");
    return {
      kind: "unix",
      path: decodeURIComponent(url.pathname),
    };
  }
  throw new Error("Control endpoint must be tcp://host:port or unix:///path/to/socket.");
}

async function prepareUnixSocket(socketPath) {
  if (!existsSync(socketPath)) return;
  try {
    const response = await requestControl(formatUnixEndpoint(socketPath), { type: "status" });
    if (response.ok) {
      throw new Error(`Relay background sync is already running at ${socketPath}`);
    }
  } catch (error) {
    if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
    await fs.rm(socketPath, { force: true });
  }
}

function defaultControlEndpoint(paths) {
  if (process.platform === "win32") return null;
  return formatUnixEndpoint(paths.socketFile);
}

function formatUnixEndpoint(socketPath) {
  return `unix://${socketPath}`;
}

async function readDaemonState(stateDir) {
  const paths = daemonPaths(stateDir);
  const state = await readJsonOrNull(paths.connectedFile);
  return {
    connected: Array.isArray(state?.connected) ? state.connected : [],
  };
}

async function writeDaemonState(stateDir, state) {
  const paths = daemonPaths(stateDir);
  await ensureStateDirectory(paths.stateDir);
  await writeJson(paths.connectedFile, state);
}

async function ensureStateDirectory(stateDir) {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(stateDir, 0o700);
}

function daemonPaths(stateDir) {
  const root = path.resolve(stateDir ?? defaultStateDir());
  return {
    stateDir: root,
    pidFile: path.join(root, "daemon.pid"),
    socketFile: path.join(root, "daemon.sock"),
    controlFile: path.join(root, "control.json"),
    connectedFile: path.join(root, "connected.json"),
    tokensFile: path.join(root, "tokens.json"),
  };
}

function daemonPluginDataPath(stateDir) {
  return path.join(daemonPaths(stateDir).stateDir, "plugin-data.json");
}

async function readPluginSettings(stateDir) {
  return (await readJsonOrNull(daemonPluginDataPath(stateDir))) ?? {};
}

async function updatePluginSettings(stateDir, updater) {
  const file = daemonPluginDataPath(stateDir);
  const current = await readPluginSettings(stateDir);
  await writeJson(file, updater(current));
}

function applyLoggingPatch(settings, logging) {
  const next = { ...settings };
  if (typeof logging.debugging === "boolean") next.debugging = logging.debugging;
  if (typeof logging.network === "boolean") {
    next.enableNetworkLogging = logging.network;
    if (logging.network) next.debugging = true;
  }
  return next;
}

function defaultStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, "rmd");
  return path.join(os.homedir(), ".local", "state", "rmd");
}

async function readPid(pidFile) {
  try {
    const text = await fs.readFile(pidFile, "utf8");
    const pid = Number(text.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(root, config) {
  const lines = [
    "format_version = 1",
    `folder_id = ${JSON.stringify(config.folderId)}`,
    `server = ${JSON.stringify(config.server)}`,
    `name = ${JSON.stringify(config.name)}`,
  ];
  if (config.relayId) lines.splice(2, 0, `relay_id = ${JSON.stringify(config.relayId)}`);
  await fs.writeFile(path.join(root, RELAY_DIR, CONFIG_FILE), `${lines.join("\n")}\n`, "utf8");
}

async function readConfig(root) {
  const text = await fs.readFile(path.join(root, RELAY_DIR, CONFIG_FILE), "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = JSON.parse(match[2]);
  }
  return {
    formatVersion: values.format_version,
    folderId: values.folder_id,
    relayId: values.relay_id ?? null,
    server: values.server,
    name: values.name,
  };
}

async function findRelayFolderRoot(start) {
  const root = await findRelayFolderRootOrNull(start);
  if (!root) throw new Error("No .relay folder found.");
  return root;
}

async function findRelayFolderRootOrNull(start) {
  let current = path.resolve(start);
  if (existsSync(current) && !(await fs.stat(current)).isDirectory()) {
    current = path.dirname(current);
  }
  while (true) {
    if (existsSync(path.join(current, RELAY_DIR))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function ensureDirectory(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function suppliedToken(options) {
  if (options.token && options.tokenFile) throw new Error("Pass either --token or --token-file, not both.");
  if (options.token) return options.token.trim();
  if (options.tokenFile) return (await fs.readFile(options.tokenFile, "utf8")).trim();
  return null;
}

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await fs.chmod(file, 0o600);
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    if (raw === "server" || raw.startsWith("server=") || raw === "no-server") {
      throw new Error("--server is unsupported. Endpoints are selected at build time; use the production or staging build.");
    }
    if (raw.startsWith("no-")) {
      options[toCamel(raw.slice(3))] = false;
      continue;
    }
    const [name, inlineValue] = raw.split("=", 2);
    const key = toCamel(name);
    if (VALUE_OPTIONS.has(name)) {
      options[key] = inlineValue ?? argv[++index];
    } else {
      options[key] = true;
    }
  }
  return { options, positional };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
