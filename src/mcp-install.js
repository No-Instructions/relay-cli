import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultStateDir } from "./control-client.js";
import { embeddedRelease } from "./release.js";
import { findInstallation } from "./updates.js";
import { identityName } from "./mcp-identity.js";
import { helpText } from "./command-help.js";

const exec = promisify(execFile);
const HELP = helpText("mcp install");

// Managed releases register the stable link so client settings survive upgrades.
// Source checkouts retain their runtime and entrypoint as separate argv elements.
export async function mcpLaunchCommand({ release = embeddedRelease, executable = process.execPath } = {}) {
  if (!release) return { command: executable, args: [fileURLToPath(new URL("../bin/relay.js", import.meta.url))] };
  const installation = await findInstallation(executable);
  return { command: installation ? path.join(installation.root, "current", "relay") : executable, args: [] };
}

function parseOptions(argv) {
  const [client, ...rest] = argv;
  if (!["claude", "codex"].includes(client)) throw new Error(HELP);
  const options = { client };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--dry-run" && !options.dryRun) { options.dryRun = true; continue; }
    if (flag === "--read-only" && !options.readOnly) { options.readOnly = true; continue; }
    const key = { "--repo": "repo", "--state-dir": "stateDir", "--name": "name", "--scope": "scope", "--agent": "agent", "--agent-name": "agentName" }[flag];
    const value = rest[++index];
    if (!key || !value || value.startsWith("-") || options[key] !== undefined) throw new Error(HELP);
    options[key] = value;
  }
  options.name ??= "relay";
  options.scope ??= "user";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.name)) throw new Error("Server names must start with a letter or digit and contain only letters, digits, underscores, or hyphens.");
  if (!["user", "local", "project"].includes(options.scope)) throw new Error("Scope must be user, local, or project.");
  if (client === "codex" && options.scope !== "user") throw new Error("Codex CLI registration supports --scope user only.");
  options.agentName ??= client === "claude" ? "Claude" : "Codex";
  if (options.agent !== undefined && !/^[a-z0-9]{15}$/.test(options.agent)) throw new Error("Invalid user_agents record ID.");
  identityName(options.agentName);
  return options;
}

async function runClient(client, args) {
  try {
    return await exec(client, args, { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${client} CLI was not found on PATH. Install ${client === "claude" ? "Claude Code" : "Codex"}, then retry.`);
    if (error.killed) throw new Error(`${client} mcp ${args[1]} did not finish within its execution limits. Check the client's MCP configuration before retrying.`);
    // Do not print list stdout: it contains unrelated server configuration.
    const detail = String(error.stderr || (args[1] === "add" ? error.stdout : "") || error.message).trim();
    throw new Error(`${client} mcp ${args[1]} failed: ${detail}`);
  }
}

export async function installMcpCommand(argv) {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  const options = parseOptions(argv);
  const server = await mcpLaunchCommand();
  server.args.push("mcp", "--state-dir", path.resolve(options.stateDir ?? defaultStateDir()));
  if (options.repo) server.args.push("--repo", path.resolve(options.repo));
  if (options.readOnly) server.args.push("--read-only");
  if (options.agent) server.args.push("--agent", options.agent);
  else server.args.push("--agent-name", options.agentName);
  const args = options.client === "claude"
    ? ["mcp", "add", "--transport", "stdio", "--scope", options.scope, options.name, "--", server.command, ...server.args]
    : ["mcp", "add", options.name, "--", server.command, ...server.args];
  if (options.dryRun) {
    console.log(JSON.stringify({ client: options.client, name: options.name, scope: options.scope, server, registration: { command: options.client, args } }, null, 2));
    return;
  }

  if (options.client === "codex") {
    // Codex add replaces an existing entry. Inspect via its supported CLI first
    // and fail closed so unrelated credentials/settings cannot be overwritten.
    const { stdout } = await runClient("codex", ["mcp", "list", "--json"]);
    let entries;
    try { entries = JSON.parse(stdout); } catch { /* validated below */ }
    if (!Array.isArray(entries) || entries.some(entry => typeof entry?.name !== "string")) {
      throw new Error("Could not read Codex MCP registrations safely; no changes made. Check `codex mcp list --json`.");
    }
    if (entries.some(entry => entry.name === options.name)) {
      throw new Error(`Codex already has an MCP server named ${options.name}. Choose another --name or remove it with \`codex mcp remove ${options.name}\` first.`);
    }
  }
  // Claude Code's add command rejects duplicate names in the selected scope.
  await runClient(options.client, args);
  console.log(`Registered ${options.name} with ${options.client === "claude" ? "Claude Code" : "Codex"} (${options.scope} scope). Restart or reload the client to load it.`);
}
