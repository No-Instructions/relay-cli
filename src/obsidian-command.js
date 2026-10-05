import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandOptions, integerOption } from "./command-options.js";

const exec = promisify(execFile);

// Obsidian's native client owns socket discovery, vault selection and the wire
// protocol. No Relay daemon, plugin code or Electron process is needed here.
export async function runObsidian(argv, { env = process.env, cwd = process.cwd(), signal } = {}) {
  let offset = 0;
  while (offset < argv.length && argv[offset].startsWith("--") && argv[offset] !== "--") {
    const option = argv[offset++];
    if (option !== "--json" && !option.includes("=")) offset++;
  }
  const { options } = commandOptions(argv.slice(0, offset), ["vault", "executable", "timeout-ms"], ["json"]);
  const args = argv.slice(offset + (argv[offset] === "--" ? 1 : 0));
  if (!args.length) throw new Error("An Obsidian command is required. Run relay obsidian --help.");
  if (args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid Obsidian argument.");
  const command = args.find(arg => !arg.startsWith("vault="));
  if (!command || !/^[a-z][a-z0-9:_-]*$/i.test(command)) throw new Error("An explicit Obsidian command is required; interactive mode is unavailable. Run relay obsidian --help.");
  if (options.vault && args.some(arg => arg.startsWith("vault="))) throw new Error("Use either --vault or Obsidian's vault= selector, not both.");
  const executable = options.executable ?? env.OBSIDIAN_CLI ?? "obsidian";
  const timeout = integerOption(options["timeout-ms"], 30_000, 1, 45_000);
  const invocation = options.vault ? [`vault=${options.vault}`, ...args] : args;
  let result;
  try {
    const operation = exec(executable, invocation, { env, cwd, signal, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    operation.child.stdin?.end();
    result = { ...await operation, exitCode: 0 };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Obsidian CLI not found: ${executable}. Enable Command line interface in Obsidian Settings → General, or set --executable /path/to/obsidian (OBSIDIAN_CLI).`);
    const interrupted = error.killed || error.signal || error.code === "ABORT_ERR";
    result = { stdout: error.stdout ?? "", stderr: error.stderr || error.message, exitCode: typeof error.code === "number" ? error.code : 1,
      ...(interrupted ? { interrupted: true, note: "Obsidian may have applied the command. Inspect the vault before retrying; no automatic retry was made." } : {}) };
  }
  // Some Obsidian/plugin versions return an error body with process status 0.
  // Preserve that status and the raw output, while surfacing recognized failures.
  const relay = command === "relay" || command.startsWith("relay:");
  const statusOutput = relay || ["eval", "help", "plugin", "plugin:install", "plugin:uninstall", "plugin:enable", "plugin:disable", "plugin:reload", "plugins:restrict"].includes(command);
  let commandError = statusOutput && /^(?:Error:|Unknown command:|Command not found:|The CLI is unable to find Obsidian\.|Command line interface is not enabled)/i.test(result.stdout.trim());
  if (relay) {
    try { commandError ||= JSON.parse(result.stdout).ok === false; } catch { /* Text output is allowed. */ }
  }
  if (commandError) result.commandError = true;
  result.ok = result.exitCode === 0 && !commandError;
  return { result, json: !!options.json };
}

export async function obsidianCommand(argv) {
  const abort = new AbortController();
  const terminate = () => abort.abort();
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    const { result, json } = await runObsidian(argv, { signal: abort.signal });
    if (json) console.log(JSON.stringify(result));
    else {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.note) console.error(result.note);
    }
    if (!result.ok) process.exitCode = result.exitCode || 1;
  } finally {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}
