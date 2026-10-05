import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { defaultStateDir } from "./user-paths.js";
export { defaultStateDir } from "./user-paths.js";

// A total deadline, rather than an idle socket timeout, bounds slow/trickling
// responses too. Mutations are never retried: losing a reply is ambiguous.
export async function requestControl(connection, request, { timeoutMs = 30_000, signal } = {}) {
  const { endpoint, authToken } = typeof connection === "string" ? { endpoint: connection } : connection;
  const parsed = parseControlEndpoint(endpoint);
  if (parsed.kind === "tcp" && !authToken) {
    throw new Error("TCP control credentials unavailable. Pass --state-dir for the daemon that owns this endpoint.");
  }
  const payload = `${JSON.stringify({ ...request, authToken })}\n`;
  if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Control request exceeds 1 MiB.");
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let phase = "connect";
    const started = Date.now();
    const socket = parsed.kind === "tcp"
      ? net.createConnection({ host: parsed.host, port: parsed.port })
      : net.createConnection(parsed.path);
    let buffer = "";
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      fn(value);
    };
    const failure = (code, message) => Object.assign(new Error(
      `Daemon control ${phase} failed after ${Date.now() - started}ms (${code}): ${message}`,
    ), { code, phase, elapsedMs: Date.now() - started, requestSent: phase === "response" });
    const abort = () => finish(reject, failure("ABORT_ERR", "Request cancelled; a sent edit may still have been applied."));
    const timer = setTimeout(() => finish(reject, failure("ETIMEDOUT", `Deadline of ${timeoutMs}ms exceeded; a sent edit may still have been applied.`)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", (error) => finish(reject, failure(error.code ?? "SOCKET_ERROR", error.message)));
    socket.setEncoding("utf8");
    socket.on("end", () => finish(reject, failure("ECONNRESET", "Daemon closed the control connection without a response.")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        finish(reject, failure("RESPONSE_TOO_LARGE", "Control response exceeds 16 MiB."));
        return;
      }
      if (!buffer.includes("\n")) return;
      try {
        finish(resolve, JSON.parse(buffer.split("\n")[0]));
      } catch {
        finish(reject, failure("INVALID_RESPONSE", "Invalid daemon control response."));
      }
    });
    socket.on("connect", () => {
      phase = "response";
      socket.write(payload);
    });
  });
}

// Discovery does not probe or silently fall back after an error. The caller
// gets the actual connection failure, with its phase and OS error code.
export async function readControlConnection(stateDir) {
  const paths = daemonPaths(stateDir);
  try {
    const stored = JSON.parse(await fs.readFile(paths.controlFile, "utf8"));
    parseControlEndpoint(stored.endpoint);
    return { endpoint: stored.endpoint, authToken: stored.authToken };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const endpoint = defaultControlEndpoint(paths);
    if (!endpoint) throw new Error("Daemon control metadata is missing. Run `relay start` with the same --state-dir.");
    return { endpoint };
  }
}

export function parseControlEndpoint(value) {
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

export function defaultControlEndpoint(paths) {
  if (process.platform === "win32") return null;
  return formatUnixEndpoint(paths.socketFile);
}

export function formatUnixEndpoint(socketPath) {
  return `unix://${socketPath}`;
}

export function daemonPaths(stateDir) {
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
