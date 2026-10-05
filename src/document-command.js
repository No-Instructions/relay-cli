import path from "node:path";
import { commandOptions, integerOption } from "./command-options.js";
import { readControlConnection, requestControl } from "./control-client.js";
import { documentPath } from "./mcp-editor-clients.js";

export async function documentsCommand(argv, enclosingRoot) {
  const [action, ...rest] = argv;
  const values = { roots: [], list: ["repo", "prefix", "offset", "limit"], search: ["repo", "prefix", "offset"], read: ["repo"] }[action];
  if (!values) throw new Error("Use relay documents <roots|list|search|read> --help.");
  const { options, positional } = commandOptions(rest, [...values, "state-dir"], ["json", ...(action === "search" ? ["case-sensitive"] : [])]);
  if (positional.length !== (["read", "search"].includes(action) ? 1 : 0)) throw new Error(`Invalid arguments. Run relay documents ${action} --help.`);
  const input = { prefix: options.prefix ?? "", offset: integerOption(options.offset, 0, 0) };
  if (action === "list") input.limit = integerOption(options.limit, 100, 1, 200);
  if (action === "search") {
    if (!positional[0] || positional[0].length > 256 || /[\r\n]/.test(positional[0])) throw new Error("Search requires a single-line literal query of 1–256 characters.");
    input.query = positional[0]; input.caseSensitive = !!options["case-sensitive"];
  }
  const root = action === "roots" ? null : path.resolve(options.repo ?? await enclosingRoot());
  if (action === "read") documentPath(root, positional[0]);
  const connection = await readControlConnection(options["state-dir"]);
  const call = async request => {
    const response = await requestControl(connection, request, { timeoutMs: 10_000 });
    if (!response.ok) throw new Error(response.error ?? "Document query failed.");
    return response;
  };
  let result;
  if (action === "roots") {
    const { status } = await call({ type: "status" });
    result = { folders: (status.connected ?? []).map(folder => ({ folder: folder.path, folderId: folder.folderId, relayId: folder.relayId,
      running: !!status.headless?.some(runtime => runtime.folder === folder.path), error: status.headlessErrors?.[folder.path] ?? null })) };
  } else if (action === "read") result = (await call({ type: "mcp_read", repo: root, path: positional[0] })).document;
  else {
    const { clientId } = await call({ type: "mcp_editor", action: "connect", repo: root });
    try { result = (await call({ type: "mcp_editor", action, repo: root, clientId, input })).result; }
    finally { await call({ type: "mcp_editor", action: "release", clientId }); }
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (action === "read") process.stdout.write(result.text);
  else if (action === "roots") for (const entry of result.folders) console.log(`${entry.folder}\t${entry.running ? "running" : entry.error ?? "unavailable"}`);
  else {
    if (action === "list") for (const entry of result.documents) console.log(`${entry.path}${entry.open ? "\t(open)" : ""}`);
    else for (const entry of result.results) for (const match of entry.matches) console.log(`${entry.path}:${match.line}:${match.snippet}`);
    for (const entry of result.skipped ?? []) console.error(`Skipped ${entry.path}: ${entry.error ?? entry.reason}`);
    if (result.nextOffset !== null) console.error(`Next page: --offset ${result.nextOffset}`);
  }
}
