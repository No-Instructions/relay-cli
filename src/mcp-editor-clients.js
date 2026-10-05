import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveSafePath } from "./safe-path.js";
import { McpNotifications } from "./mcp-notifications.js";

export const EDITOR_LEASE_MS = 60_000;
export const MAX_DOCUMENT_CHARS = 128 * 1024;

export function documentPath(root, value) {
  if (typeof value !== "string" || !value || value.includes("\0") ||
      path.isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes("\\") ||
      value.split("/").some((part) => ["", ".", "..", ".relay"].includes(part))) {
    throw new Error("Use a relative document path inside the shared folder, without traversal or .relay entries.");
  }
  return resolveSafePath(root, value);
}

// The daemon owns these leases, including opens that outlive a cancelled IPC
// call. EOF cleanup is an optimization; expiry also handles SIGKILL/crashes.
export class McpEditorClients {
  constructor(runtimes, { leaseMs = EDITOR_LEASE_MS, now = Date.now, onError = console.error } = {}) {
    this.runtimes = runtimes;
    this.leaseMs = leaseMs;
    this.now = now;
    this.onError = onError;
    this.clients = new Map();
    this.notifications = new McpNotifications(runtimes, { now });
    this.closing = new Set();
    this.stopped = false;
    this.timer = setInterval(() => { void this.expire(); }, Math.min(5000, leaseMs));
    this.timer.unref();
  }

  async handle(request) {
    if (this.stopped) throw new Error("The daemon is shutting down.");
    if (request.action === "connect") {
      const clientId = randomUUID();
      if (request.repo !== undefined && (typeof request.repo !== "string" || !path.isAbsolute(request.repo))) throw new Error("MCP folder scope must be absolute.");
      const agent = { id: request.agent, name: request.name ?? "Relay MCP" };
      this.clients.set(clientId, { agent, readOnly: request.readOnly === true, scope: request.repo ? path.resolve(request.repo) : null, expires: this.now() + this.leaseMs, sessions: new Map(), sessionResources: new Map(), opens: new Map(), opening: new Set(), closed: false });
      return { clientId, leaseMs: this.leaseMs };
    }
    const client = this.clients.get(request.clientId);
    if (!client || client.closed || client.expires <= this.now()) {
      if (client) void this.release(request.clientId, client);
      throw new Error("MCP editor lease expired or daemon restarted. Reconnect the MCP client and open a new session.");
    }
    client.expires = this.now() + this.leaseMs;
    if (request.action === "heartbeat") return { leaseMs: this.leaseMs };
    if (request.action === "release") {
      await this.release(request.clientId, client);
      return {};
    }
    if (request.action === "notifications") {
      const input = { ...request.input };
      if (input.action === "follow") {
        input.repo = typeof input.repo === "string" ? path.resolve(input.repo) : client.scope;
        if (!input.repo) throw new Error("Select a folder to follow.");
        documentPath(input.repo, input.path);
      }
      const operation = this.notifications.handle(request.clientId, client.scope, input);
      client.opening.add(operation);
      try { return { result: await operation }; }
      finally { client.opening.delete(operation); }
    }
    if (["list", "search", "read_comments"].includes(request.action)) {
      const root = typeof request.repo === "string" ? path.resolve(request.repo) : client.scope;
      if (client.scope && root !== client.scope) throw new Error("This MCP client is restricted to its selected folder.");
      const runtime = this.runtimes.get(root);
      if (!runtime) throw new Error("No headless Relay runtime is running for this exact folder root.");
      if (request.action === "read_comments") {
        documentPath(root, request.path);
        return { result: await runtime.readMcpComments(request.path) };
      }
      return { result: request.action === "list" ? runtime.listMcpDocuments(request.input) : await runtime.searchMcpDocuments(request.input) };
    }
    if (request.action === "cancel_open") {
      const operation = client.opens.get(request.openId);
      if (!operation) {
        // Separate IPC connections may be scheduled out of order. Remember
        // cancellation so a delayed open cannot create an orphan afterwards.
        client.opens.set(request.openId, { cancelled: true, sessionId: null });
        return {};
      }
      operation.cancelled = true;
      client.opens.delete(request.openId);
      const runtime = client.sessions.get(operation.sessionId);
      if (runtime) {
        client.sessions.delete(operation.sessionId);
        client.sessionResources.delete(operation.sessionId);
        await runtime.closeActiveEditor(operation.sessionId);
      }
      return {};
    }
    if (request.action === "open") {
      // Exact root matching avoids ambiguous nested folders or first-folder
      // fallback. Lexical paths still allow user-created symlink selections.
      const root = typeof request.repo === "string" ? path.resolve(request.repo) : "";
      if (client.scope && root !== client.scope) throw new Error("This MCP client is restricted to its selected folder.");
      const runtime = this.runtimes.get(root);
      if (!runtime) throw new Error("No headless Relay runtime is running for this exact folder root.");
      documentPath(root, request.path);
      const openId = request.openId ?? randomUUID();
      if (client.opens.has(openId)) throw new Error("MCP open operation already exists; opens must not be retried.");
      const operation = { cancelled: false, sessionId: null };
      const identity = runtime.mcpResourceIdentity?.();
      client.opens.set(openId, operation);
      const opening = (async () => {
        const actor = await runtime.resolveMcpIdentity({ ...client.agent, ...(request.agent === undefined ? {} : { id: request.agent }) });
        if (client.closed || operation.cancelled) throw new Error("MCP open was cancelled.");
        if (this.runtimes.get(root) !== runtime || identity !== runtime.mcpResourceIdentity?.()) throw new Error("The folder or account changed while resolving the agent.");
        const frame = await runtime.openMcpDocument(request.path, actor, { readOnly: client.readOnly });
        if (this.runtimes.get(root) !== runtime || identity !== runtime.mcpResourceIdentity?.()) {
          await runtime.closeActiveEditor(frame.sessionId);
          throw new Error("The folder or account changed while opening the editor.");
        }
        if (client.closed || operation.cancelled || client.expires <= this.now() || frame.text.length > MAX_DOCUMENT_CHARS) {
          await runtime.closeActiveEditor(frame.sessionId);
          throw new Error(client.closed || operation.cancelled || client.expires <= this.now() ? "MCP client disconnected or cancelled while opening the document." : "Document exceeds the MCP editing limit of 128 Ki characters.");
        }
        operation.sessionId = frame.sessionId;
        client.sessions.set(frame.sessionId, runtime);
        client.sessionResources.set(frame.sessionId, { root, identity: runtime.mcpResourceIdentity?.(), actor });
        return { frame: { ...frame, identity: actor } };
      })();
      client.opening.add(opening);
      try { return await opening; }
      catch (error) { client.opens.delete(openId); throw error; }
      finally { client.opening.delete(opening); }
    }
    const runtime = client.sessions.get(request.sessionId);
    if (!runtime) throw new Error("This MCP client does not own that editor session.");
    const resource = client.sessionResources.get(request.sessionId);
    if (request.action !== "close" && (this.runtimes.get(resource.root) !== runtime || resource.identity !== runtime.mcpResourceIdentity?.())) {
      throw new Error("The editor's folder or account changed. Close it and open a new session.");
    }
    if (request.action === "frame") return { frame: runtime.activeEditorFrame(request.sessionId) };
    // Read-only clients may hold sessions for presence and reading only.
    if (client.readOnly && (request.action === "apply" || (request.action === "comments" && request.input?.action !== "read"))) {
      throw new Error("This MCP client is read-only.");
    }
    if (request.action === "comments") {
      if (request.input?.action === "read") return { result: runtime.reviewActiveEditor(request.sessionId) };
      return { result: runtime.applyMcpComment(request.sessionId, request.input ?? {}, resource.actor) };
    }
    if (request.action === "apply") {
      for (const value of [request.baseText, request.desiredText]) {
        if (typeof value !== "string" || value.length > MAX_DOCUMENT_CHARS) throw new Error("Edits require baseText and desiredText within 128 Ki characters each.");
      }
      return { result: runtime.applyActiveEditor(request.sessionId, {
        baseText: request.baseText, desiredText: request.desiredText,
        cursor: request.cursor, selection: request.selection,
      }) };
    }
    if (request.action === "presence") {
      if (request.baseText !== undefined && (typeof request.baseText !== "string" || request.baseText.length > MAX_DOCUMENT_CHARS)) {
        throw new Error("baseText must be text within 128 Ki characters.");
      }
      return { result: runtime.presenceActiveEditor(request.sessionId, {
        baseText: request.baseText, cursor: request.cursor, selection: request.selection,
      }) };
    }
    if (request.action === "close") {
      client.sessions.delete(request.sessionId);
      client.sessionResources.delete(request.sessionId);
      for (const [id, operation] of client.opens) {
        if (operation.sessionId === request.sessionId) client.opens.delete(id);
      }
      await runtime.closeActiveEditor(request.sessionId);
      return { closed: true };
    }
    throw new Error(`Unknown MCP editor action: ${request.action}`);
  }

  release(id, client) {
    if (client.closed) return client.cleanup;
    client.closed = true;
    this.clients.delete(id);
    client.cleanup = (async () => {
      await Promise.allSettled([...client.opening]);
      this.notifications.detach(id);
      const sessions = [...client.sessions];
      client.sessions.clear();
      client.sessionResources.clear();
      client.opens.clear();
      const results = await Promise.allSettled(sessions.map(([sessionId, runtime]) => runtime.closeActiveEditor(sessionId)));
      for (const result of results) {
        if (result.status === "rejected") this.onError(`MCP editor cleanup failed: ${result.reason?.message ?? result.reason}`);
      }
    })();
    this.closing.add(client.cleanup);
    void client.cleanup.finally(() => this.closing.delete(client.cleanup));
    return client.cleanup;
  }

  async expire() {
    await Promise.all([...this.clients].filter(([, client]) => client.expires <= this.now()).map(([id, client]) => this.release(id, client)));
  }

  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const [id, client] of this.clients) this.release(id, client);
    await Promise.all([...this.closing]);
    await this.notifications.close();
  }
}
