import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliInvocation } from "./release.js";

const exec = promisify(execFile);
const READ_ONLY_COMMANDS = ["status", "sync-status", "relays", "folders", "documents", "version"];

// A read-only MCP server may inspect state but not change logins, folders or
// sync. Help is always allowed; so is the tool reference.
export function assertReadOnlyCli(args) {
  const help = !args.length || args[0] === "help" || args.some(arg => ["--help", "-h"].includes(arg));
  if (help || READ_ONLY_COMMANDS.includes(args[0]) || (args[0] === "mcp" && args[1] === "tools")) return;
  throw new Error(`This MCP server is read-only; relay_cli allows only ${READ_ONLY_COMMANDS.join(", ")}, mcp tools and help.`);
}

// The same installed CLI, with an argv boundary rather than a shell. A separate
// short-lived process keeps CLI lifecycle/stdout handling out of the MCP stream.
export async function runMcpCli(args, { stateDir, cwd, signal } = {}) {
  if (!args.length) args = ["--help"];
  const help = args[0] === "help" || args.some(arg => ["--help", "-h"].includes(arg));
  if (!help && (args[0]?.startsWith("_") || args.some(arg => ["--foreground", "--scheduled", "--update-restart"].includes(arg.split("=")[0])) ||
      (args[0] === "mcp" && !["install", "tools"].includes(args[1])))) {
    throw new Error("Use administrative CLI commands here; foreground/internal workers and nested MCP servers cannot run inside relay_cli.");
  }
  // Administrative commands target this MCP daemon by default; an explicit
  // --state-dir remains available as in the ordinary CLI.
  const stateful = ["login", "logout", "auth", "start", "stop", "init", "clone", "connect", "disconnect", "status", "sync-status", "logging", "relays", "folders", "documents", "agent", "debug"].includes(args[0]) || (args[0] === "mcp" && args[1] === "install");
  const invocation = [...args];
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  if (!help && stateful && stateDir && !flags.some(arg => arg === "--state-dir" || arg.startsWith("--state-dir="))) invocation.splice(separator < 0 ? invocation.length : separator, 0, "--state-dir", stateDir);
  let result;
  try {
    const operation = exec(process.execPath, cliInvocation(invocation), { cwd, signal, timeout: 60_000, maxBuffer: 256 * 1024, windowsHide: true });
    operation.child.stdin?.end();
    result = { ...await operation, exitCode: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr || error.message, exitCode: typeof error.code === "number" ? error.code : null,
      ...(error.killed || error.signal || error.code === "ABORT_ERR" ? { interrupted: true, signal: error.signal ?? null, note: "The command was interrupted; a requested change may already have happened. Inspect state before retrying." } : {}) };
  }
  const limit = 64 * 1024;
  return { exitCode: result.exitCode, stdout: result.stdout.slice(0, limit), stderr: result.stderr.slice(0, limit),
    ...(result.stdout.length > limit || result.stderr.length > limit ? { truncated: true } : {}),
    ...(result.interrupted ? { interrupted: true, signal: result.signal, note: result.note } : {}) };
}
