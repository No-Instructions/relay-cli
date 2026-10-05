import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { openSafeFile } from "../safe-path.js";
import { documentPath, MAX_DOCUMENT_CHARS } from "../mcp-editor-clients.js";
import { TFile, TFolder } from "./obsidian-shim";
import type { FileSystemVault } from "./FileSystemVault";

export async function readMcpText(root: string, relativePath: string) {
  documentPath(root, relativePath);
  const file = await openSafeFile(root, relativePath, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(MAX_DOCUMENT_CHARS * 4 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length === buffer.length) throw new Error("File exceeds the MCP reading limit.");
    const bytes = buffer.subarray(0, length);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.length > MAX_DOCUMENT_CHARS) throw new Error("File exceeds the MCP reading limit of 128 Ki characters.");
    return { path: relativePath, text, hash: createHash("sha256").update(bytes).digest("hex"), source: "disk" };
  } finally { await file.close(); }
}

async function absent(file: string) {
  try { await fs.lstat(file); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Destination already exists; it will not be overwritten.");
}

export async function mcpFiles(root: string, vaultRoot: string, vault: FileSystemVault, input: {
  action: string; path?: string; destination?: string; text?: string; expectedHash?: string | null;
  recursive?: boolean; offset?: number; limit?: number;
}) {
  const relative = input.path ?? "";
  if (relative || input.action !== "list") documentPath(root, relative);
  const vaultPath = relative ? `${vaultRoot}/${relative}` : vaultRoot;
  vault.reconcile(vaultPath);
  const entry = vault.getAbstractFileByPath(vaultPath);
  if (input.action === "list") {
    if (!(entry instanceof TFolder)) throw new Error("Path is not an indexed directory.");
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid listing offset or limit.");
    const children = [...entry.children].sort((a, b) => a.path.localeCompare(b.path));
    return {
      path: relative,
      entries: children.slice(offset, offset + limit).map(item => ({
        path: item.path.slice(vaultRoot.length + 1), kind: item instanceof TFolder ? "directory" : "file",
        ...(item instanceof TFile ? { size: item.stat.size, mtime: item.stat.mtime } : {}),
      })),
      nextOffset: offset + limit < children.length ? offset + limit : null,
    };
  }
  if (input.action === "read") {
    if (!(entry instanceof TFile)) throw new Error("Path is not an indexed file.");
    return readMcpText(root, relative);
  }
  const parentExists = (target: string) => {
    const parent = path.posix.dirname(target);
    vault.reconcile(parent);
    if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw new Error("Parent directory does not exist. Create it first.");
  };
  if (input.action === "write") {
    if (typeof input.text !== "string" || input.text.length > MAX_DOCUMENT_CHARS) throw new Error("Text exceeds the MCP write limit of 128 Ki characters.");
    if (input.expectedHash === null) {
      parentExists(vaultPath);
      // Exclusive create prevents a delayed request from clobbering a new file,
      // including an existing symlink whose target is currently absent.
      const file = await fs.open(documentPath(root, relative), "wx");
      try { await file.writeFile(input.text, "utf8"); }
      finally { await file.close(); vault.reconcile(vaultPath); }
    } else {
      if (!(entry instanceof TFile)) throw new Error("Path is not an indexed file.");
      const current = await readMcpText(root, relative);
      if (typeof input.expectedHash !== "string" || current.hash !== input.expectedHash) throw new Error("File changed since it was read. Read it again before writing.");
      await vault.modify(entry, input.text);
    }
    return { path: relative, hash: createHash("sha256").update(input.text).digest("hex"), persistence: "written-to-disk", remoteSyncConfirmed: false };
  }
  if (input.action === "mkdir") {
    parentExists(vaultPath);
    await absent(documentPath(root, relative));
    await vault.createFolder(vaultPath);
    return { path: relative, created: true, remoteSyncConfirmed: false };
  }
  if (!entry) throw new Error("Path is not indexed in the selected folder.");
  if (input.action === "move") {
    const destination = input.destination ?? "";
    const target = documentPath(root, destination);
    if (destination.startsWith(`${relative}/`)) throw new Error("Cannot move a directory inside itself.");
    await absent(target);
    const targetVaultPath = `${vaultRoot}/${destination}`;
    parentExists(targetVaultPath);
    await vault.performRename(entry, targetVaultPath);
    return { path: destination, previousPath: relative, moved: true, remoteSyncConfirmed: false };
  }
  if (input.action === "trash") {
    if (entry instanceof TFolder && entry.children.length && input.recursive !== true) throw new Error("Nonempty directories require recursive:true to move their contents to trash.");
    await vault.trash(entry, false);
    return { path: relative, trashed: true, remoteSyncConfirmed: false };
  }
  throw new Error(`Unknown file operation: ${input.action}`);
}
