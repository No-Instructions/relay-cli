import fs from "node:fs/promises";
import { constants, readdirSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { isUnavailablePathError, openSafeFile, resolveSafePath, statSyncEntry } from "../safe-path.js";
import {
  FileManager,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
  normalizePath,
  type FileStats,
} from "./obsidian-shim";

function toVaultPath(input: string): string {
  return normalizePath(input);
}

function statsFrom(stat: Stats | Awaited<ReturnType<typeof fs.stat>>): FileStats {
  return {
    ctime: stat.ctimeMs,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
}

/** "a/b/name.md" → "a/b/name (n).md"; extensionless paths get a bare suffix. */
function suffixedSlot(candidate: string, counter: number): string {
  const dot = candidate.lastIndexOf(".");
  const slash = candidate.lastIndexOf("/");
  const hasExtension = dot > slash + 1;
  const stem = hasExtension ? candidate.slice(0, dot) : candidate;
  const extension = hasExtension ? candidate.slice(dot) : "";
  return `${stem} (${counter})${extension}`;
}

export interface InternalWriteInfo {
  exists: boolean;
  kind?: "file" | "folder";
  stats?: FileStats;
  vaultPath: string;
}

type InternalWriteCallback = (info: InternalWriteInfo) => void;

export class FileSystemAdapter {
  private pendingTrash = new Map<string, Promise<void>>();

  constructor(
    private root: string,
    private onInternalWrite: InternalWriteCallback = () => {},
    private scopeRoot: string = root,
  ) {
    this.root = path.resolve(root);
    this.scopeRoot = path.resolve(scopeRoot);
  }

  getSafePath(vaultPath: string): string {
    const target = path.resolve(this.root, toVaultPath(vaultPath));
    return resolveSafePath(this.scopeRoot, path.relative(this.scopeRoot, target));
  }

  private openFile(vaultPath: string, flags: number) {
    return openSafeFile(this.scopeRoot, path.relative(this.scopeRoot, this.getSafePath(vaultPath)), flags);
  }

  statEntry(vaultPath: string): Stats {
    return statSyncEntry(this.scopeRoot, path.relative(this.scopeRoot, this.getSafePath(vaultPath)));
  }

  private async markInternalWrite(vaultPath: string): Promise<void> {
    const normalized = toVaultPath(vaultPath);
    try {
      const stat = await fs.stat(this.getSafePath(normalized));
      this.onInternalWrite({
        exists: true,
        kind: stat.isDirectory() ? "folder" : "file",
        stats: statsFrom(stat),
        vaultPath: normalized,
      });
    } catch (error: any) {
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
      this.onInternalWrite({
        exists: false,
        vaultPath: normalized,
      });
    }
  }

  async append(vaultPath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.getSafePath(vaultPath)), { recursive: true });
    await this.writeContent(vaultPath, content, true);
    await this.markInternalWrite(vaultPath);
  }

  async exists(vaultPath: string): Promise<boolean> {
    try {
      await fs.stat(this.getSafePath(vaultPath));
      return true;
    } catch (error: any) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async mkdir(vaultPath: string): Promise<void> {
    await fs.mkdir(this.getSafePath(vaultPath), { recursive: true });
    await this.markInternalWrite(vaultPath);
  }

  async read(vaultPath: string): Promise<string> {
    const file = await this.openFile(vaultPath, constants.O_RDONLY);
    try {
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }

  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    const file = await this.openFile(vaultPath, constants.O_RDONLY);
    try {
      const buffer = await file.readFile();
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    } finally {
      await file.close();
    }
  }

  async remove(vaultPath: string): Promise<void> {
    await fs.rm(this.getSafePath(vaultPath), { force: true, recursive: true });
    await this.markInternalWrite(vaultPath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.mkdir(path.dirname(this.getSafePath(newPath)), { recursive: true });
    await fs.rename(this.getSafePath(oldPath), this.getSafePath(newPath));
    await this.markInternalWrite(oldPath);
    await this.markInternalWrite(newPath);
  }

  async stat(vaultPath: string): Promise<FileStats | null> {
    try {
      return statsFrom(await fs.stat(this.getSafePath(vaultPath)));
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Move a file (or folder) into `.relay/trash/` instead of hard-deleting it,
   * mirroring Obsidian's trash semantics (folder-sync-spec P5: delete-wins is
   * only acceptable when the loser is recoverable).
   *
   * The trash lives inside the path's top-level folder (the shared folder in
   * relay-cli), preserving the path relative to that folder. Existing trash
   * slots are never overwritten; collisions get a numeric suffix.
   */
  async trashLocal(vaultPath: string): Promise<void> {
    const normalized = toVaultPath(vaultPath);
    this.getSafePath(normalized);
    const existing = this.pendingTrash.get(normalized);
    if (existing) return existing;
    // Relay can submit a deleted folder and its children together. Move the
    // ancestor once: independently trashing children of a directory link would
    // remove target contents before the link itself is moved to the trash.
    const operation = (async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const [ancestor, pending] of this.pendingTrash) {
        if (normalized.startsWith(`${ancestor}/`)) {
          await pending;
          await this.markInternalWrite(normalized);
          return;
        }
      }
      await this.moveToTrash(normalized);
    })();
    this.pendingTrash.set(normalized, operation);
    try {
      await operation;
    } finally {
      this.pendingTrash.delete(normalized);
    }
  }

  private async moveToTrash(normalized: string): Promise<void> {
    const source = this.getSafePath(normalized);
    try {
      await fs.lstat(source);
    } catch (error: any) {
      if (error.code === "ENOENT") return; // nothing to trash
      throw error;
    }

    const segments = normalized.split("/").filter(Boolean);
    const folderRoot = segments.length > 1 ? segments[0] : "";
    const relative = segments.length > 1 ? segments.slice(1).join("/") : normalized;
    const trashBase = folderRoot ? `${folderRoot}/.relay/trash` : ".relay/trash";
    const candidate = `${trashBase}/${relative}`;

    // Other operations can fill a slot between the existence check and rename.
    // Collisions surfaced by rename advance to the next suffixed slot.
    for (let counter = 0; ; counter += 1) {
      if (counter > 10_000) {
        throw new Error(`trashLocal: no free trash slot found for ${candidate}`);
      }
      const destination = counter === 0 ? candidate : suffixedSlot(candidate, counter);
      try {
        await fs.lstat(this.getSafePath(destination));
        continue; // a dangling link still occupies a trash slot
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(this.getSafePath(destination)), { recursive: true });
      try {
        await fs.rename(this.getSafePath(normalized), this.getSafePath(destination));
        break;
      } catch (error: any) {
        // The slot got claimed between the check and the rename — advance.
        if (
          error.code === "ENOTEMPTY" ||
          error.code === "EEXIST" ||
          error.code === "ENOTDIR"
        ) {
          continue;
        }
        throw error;
      }
    }
    // Announce the removal (not the .relay destination, which the vault
    // model ignores) so the model adopts it and watcher echoes suppress.
    await this.markInternalWrite(normalized);
  }

  async write(vaultPath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(this.getSafePath(vaultPath)), { recursive: true });
    await this.writeContent(vaultPath, content);
    await this.markInternalWrite(vaultPath);
  }

  async writeBinary(vaultPath: string, content: ArrayBuffer): Promise<void> {
    await fs.mkdir(path.dirname(this.getSafePath(vaultPath)), { recursive: true });
    await this.writeContent(vaultPath, Buffer.from(content));
    await this.markInternalWrite(vaultPath);
  }

  private async writeContent(vaultPath: string, content: string | Buffer, append = false): Promise<void> {
    // Check the opened file before truncating it (special files are excluded).
    const file = await this.openFile(vaultPath,
      constants.O_WRONLY | constants.O_CREAT | (append ? constants.O_APPEND : 0));
    try {
      if (!append) await file.truncate(0);
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  }
}

/**
 * A self-consistent Obsidian Vault backed by the filesystem.
 *
 * Reads (getAbstractFileByPath, folder children, recurseChildren) are served
 * exclusively from an in-memory model, exactly like Obsidian's vault index:
 * a file exists for consumers at the moment its vault event fires, never
 * before. The model changes in only two ways:
 *
 *  - `reconcile`/`reconcileRename`: the filesystem-event pipeline compares
 *    live disk state with the model and applies the difference atomically
 *    (synchronous stat + model mutation + event emission, no awaits between).
 *  - The vault's own write APIs (create/modify/createFolder/trash and
 *    FileManager renames), which update the model and fire their events
 *    synchronously with the operation, matching Obsidian's behavior for
 *    programmatic edits.
 *
 * The adapter remains a raw filesystem surface (as in Obsidian).
 */
export class FileSystemVault extends Vault {
  adapter: FileSystemAdapter;
  fileManager: FileManager;
  private rootFolder: TFolder;
  private entries = new Map<string, TAbstractFile>();

  constructor(
    private rootPath: string,
    private name = path.basename(rootPath) || "Relay",
    onInternalWrite: InternalWriteCallback = () => {},
    scopeRoot: string = rootPath,
  ) {
    super();
    this.rootPath = path.resolve(rootPath);
    // Adapter writes are raw filesystem operations (as in Obsidian), but the
    // model must still learn about them: adopt silently, then let the host's
    // echo suppression drop the watcher's later observation of the same write.
    this.adapter = new FileSystemAdapter(this.rootPath, (info) => {
      this.adoptInternalWrite(info);
      onInternalWrite(info);
    }, scopeRoot);
    this.fileManager = new FileManager(this);
    this.rootFolder = new TFolder("");
    this.rootFolder.vault = this;
  }

  getName(): string {
    return this.name;
  }

  getRoot(): TFolder {
    return this.rootFolder;
  }

  getAbstractFileByPath(vaultPath: string): TAbstractFile | null {
    const normalized = toVaultPath(vaultPath);
    if (normalized === "" || normalized === "/") return this.rootFolder;
    return this.entries.get(normalized) ?? null;
  }

  getFolderByPath(vaultPath: string): TFolder | null {
    const file = this.getAbstractFileByPath(vaultPath);
    return file instanceof TFolder ? file : null;
  }

  /**
   * Route a filesystem observation into the model. The event name is
   * advisory: except for renames, the reconciliation derives the actual
   * change from disk truth versus the model.
   */
  async refreshAndTrigger(
    event: "create" | "delete" | "modify" | "rename",
    vaultPath: string,
    oldVaultPath?: string,
  ): Promise<void> {
    if (event === "rename") {
      if (!oldVaultPath) throw new Error("rename events require oldVaultPath");
      this.reconcileRename(vaultPath, oldVaultPath);
      return;
    }
    this.reconcile(vaultPath);
  }

  /** Populate the model from disk without emitting events (startup index). */
  rememberTree(vaultPath: string): void {
    const normalized = toVaultPath(vaultPath);
    if (this.isIgnoredPath(normalized)) return;
    let stat: Stats;
    try {
      stat = this.adapter.statEntry(normalized);
    } catch (error: any) {
      if (isUnavailablePathError(error)) return;
      throw error;
    }
    if (!stat.isDirectory()) {
      if (normalized && stat.isFile()) this.insertFile(normalized, statsFrom(stat), true);
      return;
    }
    if (normalized) this.ensureFolder(normalized, false);
    let names: string[] = [];
    try {
      names = readdirSync(this.adapter.getSafePath(normalized));
    } catch (error: any) {
      if (!isUnavailablePathError(error)) throw error;
    }
    for (const entry of names.sort((a, b) => a.localeCompare(b))) {
      if (entry === ".relay") continue;
      this.rememberTree(normalized ? `${normalized}/${entry}` : entry);
    }
  }

  /**
   * Compare one path's live disk state against the model and apply the
   * difference. Synchronous by design: stat, model mutation, and event
   * emission happen with no interleaving point between them.
   */
  reconcile(vaultPath: string): void {
    const normalized = toVaultPath(vaultPath);
    if (!normalized || normalized === "/" || this.isIgnoredPath(normalized)) return;

    let stat: Stats | null = null;
    try {
      stat = this.adapter.statEntry(normalized);
    } catch (error: any) {
      if (!isUnavailablePathError(error)) throw error;
    }
    const existing = this.entries.get(normalized);

    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      if (!existing) return;
      this.deleteSubtreeWithEvents(existing);
      return;
    }

    if (stat.isDirectory()) {
      if (existing instanceof TFile) this.deleteSubtreeWithEvents(existing);
      this.ensureFolder(normalized, true);
      this.reconcileFolderChildren(normalized);
      return;
    }

    const stats = statsFrom(stat);
    if (existing instanceof TFolder) this.deleteSubtreeWithEvents(existing);
    const entry = this.entries.get(normalized);
    if (!entry) {
      this.insertFile(normalized, stats, false);
      return;
    }
    const file = entry as TFile;
    if (
      file.stat.mtime !== stats.mtime ||
      file.stat.size !== stats.size ||
      file.stat.ctime !== stats.ctime
    ) {
      file.stat = stats;
      this.trigger("modify", file);
    }
  }

  /**
   * Apply a move observation. Preserves object identity across the rename
   * (as Obsidian does) when the model and disk agree; degrades to per-path
   * reconciliation otherwise.
   */
  reconcileRename(newVaultPath: string, oldVaultPath: string): void {
    const newNormalized = toVaultPath(newVaultPath);
    const oldNormalized = toVaultPath(oldVaultPath);
    if (this.isIgnoredPath(newNormalized) || this.isIgnoredPath(oldNormalized)) return;

    const entry = this.entries.get(oldNormalized);
    let stat: Stats | null = null;
    try {
      stat = this.adapter.statEntry(newNormalized);
    } catch (error: any) {
      if (!isUnavailablePathError(error)) throw error;
    }

    if (!entry || !stat || this.entries.has(newNormalized)) {
      this.reconcile(oldNormalized);
      this.reconcile(newNormalized);
      return;
    }

    this.rekeySubtree(entry, newNormalized);
    if (entry instanceof TFile && stat.isFile()) entry.stat = statsFrom(stat);
    this.trigger("rename", entry, oldNormalized);
    if (entry instanceof TFolder) this.reconcileFolderChildren(newNormalized);
  }

  // ---- vault write APIs: model + event synchronous with the operation ----

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async modify(file: TFile, data: string): Promise<void> {
    await this.adapter.write(file.path, data);
    this.adoptFileStat(file.path);
    this.trigger("modify", this.entries.get(toVaultPath(file.path)) ?? file);
  }

  async append(file: TFile, data: string): Promise<void> {
    await this.adapter.append(file.path, data);
    this.adoptFileStat(file.path);
    this.trigger("modify", this.entries.get(toVaultPath(file.path)) ?? file);
  }

  async create(vaultPath: string, data: string): Promise<TFile> {
    const normalized = toVaultPath(vaultPath);
    await this.adapter.write(normalized, data);
    const existing = this.entries.get(normalized);
    if (existing instanceof TFile) {
      this.adoptFileStat(normalized);
      this.trigger("create", existing);
      return existing;
    }
    const stats = statsFrom(statSync(this.adapter.getSafePath(normalized)));
    const file = this.insertFile(normalized, stats, false);
    return file;
  }

  async createFolder(vaultPath: string): Promise<TFolder> {
    const normalized = toVaultPath(vaultPath);
    await this.adapter.mkdir(normalized);
    const folder = this.ensureFolder(normalized, false);
    this.trigger("create", folder);
    return folder;
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    await this.adapter.trashLocal(file.path);
    this.removeSubtree(toVaultPath(file.path));
    this.trigger("delete", file);
  }

  /**
   * Plugin-initiated rename: move the model first (preserving object
   * identity), then the disk, then announce — so no observer can see disk
   * and model disagree, and the adapter's adoption finds the entry already
   * at its new path.
   */
  async performRename(file: TAbstractFile, newPath: string): Promise<void> {
    const oldPath = toVaultPath(file.path);
    const newNormalized = toVaultPath(newPath);
    this.adapter.getSafePath(oldPath);
    this.adapter.getSafePath(newNormalized);
    const entry = this.entries.get(oldPath);
    if (!entry) {
      await this.adapter.rename(oldPath, newNormalized);
      this.reconcile(oldPath);
      this.reconcile(newNormalized);
      return;
    }
    this.rekeySubtree(entry, newNormalized);
    try {
      await this.adapter.rename(oldPath, newNormalized);
    } catch (error) {
      this.rekeySubtree(entry, oldPath);
      throw error;
    }
    this.trigger("rename", entry, oldPath);
  }

  /** Silently mirror a raw adapter write into the model. */
  private adoptInternalWrite(info: InternalWriteInfo): void {
    const normalized = toVaultPath(info.vaultPath);
    if (!normalized || normalized === "/" || this.isIgnoredPath(normalized)) return;
    if (!info.exists) {
      this.removeSubtree(normalized);
      return;
    }
    if (info.kind === "folder") {
      const entry = this.entries.get(normalized);
      if (entry instanceof TFile) this.removeSubtree(normalized);
      this.ensureFolder(normalized, false);
      return;
    }
    const entry = this.entries.get(normalized);
    if (entry instanceof TFile) {
      if (info.stats) entry.stat = info.stats;
      return;
    }
    if (entry instanceof TFolder) this.removeSubtree(normalized);
    if (info.stats) this.insertFile(normalized, info.stats, true);
  }

  // ---- model internals ----

  private isIgnoredPath(vaultPath: string): boolean {
    return vaultPath.split("/").includes(".relay");
  }

  private parentPathOf(vaultPath: string): string {
    const index = vaultPath.lastIndexOf("/");
    return index < 0 ? "" : vaultPath.slice(0, index);
  }

  private folderAt(vaultPath: string): TFolder | null {
    if (vaultPath === "") return this.rootFolder;
    const entry = this.entries.get(vaultPath);
    return entry instanceof TFolder ? entry : null;
  }

  private attachChild(parent: TFolder, child: TAbstractFile): void {
    child.parent = parent;
    if (parent.children.includes(child)) return;
    const index = parent.children.findIndex(
      (sibling) => sibling.name.localeCompare(child.name) > 0,
    );
    if (index < 0) parent.children.push(child);
    else parent.children.splice(index, 0, child);
  }

  private detachChild(child: TAbstractFile): void {
    const parent = child.parent ?? this.rootFolder;
    parent.children = parent.children.filter((sibling) => sibling !== child);
  }

  /**
   * Ensure a folder entry exists. Ancestors are always adopted silently —
   * only the explicitly observed path announces itself (when `announceSelf`).
   */
  private ensureFolder(vaultPath: string, announceSelf: boolean): TFolder {
    if (vaultPath === "") return this.rootFolder;
    const existing = this.entries.get(vaultPath);
    if (existing instanceof TFolder) return existing;
    const parent = this.ensureFolder(this.parentPathOf(vaultPath), false);
    const folder = new TFolder(vaultPath);
    folder.vault = this;
    this.entries.set(vaultPath, folder);
    this.attachChild(parent, folder);
    if (announceSelf) this.trigger("create", folder);
    return folder;
  }

  private insertFile(vaultPath: string, stats: FileStats, silent: boolean): TFile {
    const parent = this.ensureFolder(this.parentPathOf(vaultPath), false);
    const file = new TFile(vaultPath, stats);
    file.vault = this;
    this.entries.set(vaultPath, file);
    this.attachChild(parent, file);
    if (!silent) this.trigger("create", file);
    return file;
  }

  /** Refresh (or silently adopt) the model stat for a plugin-written file. */
  private adoptFileStat(vaultPath: string): void {
    const normalized = toVaultPath(vaultPath);
    let stat: Stats;
    try {
      stat = statSync(this.adapter.getSafePath(normalized));
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const entry = this.entries.get(normalized);
    if (entry instanceof TFile) {
      entry.stat = statsFrom(stat);
      return;
    }
    this.insertFile(normalized, statsFrom(stat), true);
  }

  /** Remove a subtree from the model (no events). Children before parents. */
  private removeSubtree(vaultPath: string): TAbstractFile[] {
    const entry = this.entries.get(vaultPath);
    if (!entry) return [];
    const removed: TAbstractFile[] = [];
    const collect = (item: TAbstractFile) => {
      if (item instanceof TFolder) {
        for (const child of [...item.children]) collect(child);
      }
      removed.push(item);
    };
    collect(entry);
    for (const item of removed) this.entries.delete(item.path);
    this.detachChild(entry);
    return removed;
  }

  private deleteSubtreeWithEvents(entry: TAbstractFile): void {
    const removed = this.removeSubtree(entry.path);
    for (const item of removed) this.trigger("delete", item);
  }

  /** Re-key an entry (and any descendants) to a new path in place. */
  private rekeySubtree(entry: TAbstractFile, newPath: string): void {
    const oldPath = entry.path;
    this.detachChild(entry);
    const update = (node: TAbstractFile) => {
      this.entries.delete(node.path);
      node.path =
        node.path === oldPath ? newPath : newPath + node.path.slice(oldPath.length);
      node.name = node.path.split("/").filter(Boolean).at(-1) ?? "";
      if (node instanceof TFile) {
        const dot = node.name.lastIndexOf(".");
        node.extension = dot >= 0 ? node.name.slice(dot + 1) : "";
        node.basename = dot >= 0 ? node.name.slice(0, dot) : node.name;
      }
      this.entries.set(node.path, node);
      if (node instanceof TFolder) {
        for (const child of node.children) update(child);
      }
    };
    update(entry);
    const parent = this.ensureFolder(this.parentPathOf(newPath), false);
    this.attachChild(parent, entry);
  }

  /** Bring a known folder's children in line with disk (recursive). */
  private reconcileFolderChildren(folderPath: string): void {
    const folder = this.folderAt(folderPath);
    if (!folder) return;
    let names: string[] = [];
    try {
      names = readdirSync(this.adapter.getSafePath(folderPath));
    } catch (error: any) {
      if (isUnavailablePathError(error)) {
        if (folderPath) this.reconcile(folderPath);
        return;
      }
      throw error;
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (name === ".relay") continue;
      const childPath = folderPath ? `${folderPath}/${name}` : name;
      seen.add(childPath);
      this.reconcile(childPath);
    }
    for (const child of [...folder.children]) {
      if (!seen.has(child.path)) this.reconcile(child.path);
    }
  }
}
