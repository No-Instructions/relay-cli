import { EventEmitter } from "node:events";
import yaml from "js-yaml";
import { requestBinary } from "../network.js";

export const apiVersion = "1.7.2";

export const Platform = {
  isAndroidApp: false,
  isDesktop: true,
  isIosApp: false,
  isLinux: process.platform === "linux",
  isMacOS: process.platform === "darwin",
  isMobile: false,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isWin: process.platform === "win32",
};

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export class TAbstractFile {
  name: string;
  parent: TFolder | null = null;
  vault: Vault | null = null;

  constructor(public path: string) {
    this.name = path.split("/").filter(Boolean).at(-1) ?? "";
  }
}

export class TFile extends TAbstractFile {
  extension: string;
  basename: string;

  constructor(path: string, public stat: FileStats) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Vault extends EventEmitter {
  // Concrete implementation lives in FileSystemVault.
  adapter: any;

  getName(): string {
    return "Relay";
  }

  getRoot(): TFolder {
    return new TFolder("");
  }

  getAbstractFileByPath(_path: string): TAbstractFile | null {
    return null;
  }

  getFolderByPath(path: string): TFolder | null {
    const file = this.getAbstractFileByPath(path);
    return file instanceof TFolder ? file : null;
  }

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path);
  }

  async modify(file: TFile, data: string): Promise<void> {
    await this.adapter.write(file.path, data);
    this.trigger("modify", file);
  }

  async append(file: TFile, data: string): Promise<void> {
    await this.adapter.append(file.path, data);
    this.trigger("modify", file);
  }

  async create(path: string, data: string): Promise<TFile> {
    await this.adapter.write(path, data);
    const file = this.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Failed to create file: ${path}`);
    this.trigger("create", file);
    return file;
  }

  async createFolder(path: string): Promise<TFolder> {
    await this.adapter.mkdir(path);
    const folder = this.getAbstractFileByPath(path);
    if (!(folder instanceof TFolder)) throw new Error(`Failed to create folder: ${path}`);
    this.trigger("create", folder);
    return folder;
  }

  async trash(file: TAbstractFile, _system: boolean): Promise<void> {
    await this.adapter.trashLocal(file.path);
    this.trigger("delete", file);
  }

  on(name: string, callback: (...args: any[]) => void): () => void {
    super.on(name, callback);
    return () => this.off(name, callback);
  }

  trigger(name: string, ...args: any[]): void {
    this.emit(name, ...args);
  }

  static recurseChildren(folder: TFolder, callback: (file: TAbstractFile) => void): void {
    for (const child of folder.children) {
      callback(child);
      if (child instanceof TFolder) {
        Vault.recurseChildren(child, callback);
      }
    }
  }
}

export class FileManager {
  constructor(private vault?: Vault) {}

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    if (!this.vault) throw new Error("FileManager has no vault");
    const oldPath = file.path;
    const normalizedNewPath = normalizePath(newPath);
    const performRename = (this.vault as any).performRename;
    if (typeof performRename === "function") {
      await performRename.call(this.vault, file, normalizedNewPath);
      return;
    }
    await this.vault.adapter.rename(oldPath, normalizedNewPath);
    const refreshAndTrigger = (this.vault as any).refreshAndTrigger;
    if (typeof refreshAndTrigger === "function") {
      await refreshAndTrigger.call(this.vault, "rename", normalizedNewPath, oldPath);
      return;
    }
    const moved = this.vault.getAbstractFileByPath(normalizedNewPath);
    if (moved) this.vault.trigger("rename", moved, oldPath);
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    await this.vault?.trash(file, false);
  }
}

export class MetadataCache extends EventEmitter {
  on(name: string, callback: (...args: any[]) => void): () => void {
    super.on(name, callback);
    return () => this.off(name, callback);
  }

  trigger(name: string, ...args: any[]): void {
    this.emit(name, ...args);
  }
}

export class Workspace extends EventEmitter {
  onLayoutReady(callback: () => void): void {
    queueMicrotask(callback);
  }

  getRightLeaf(): WorkspaceLeaf | null {
    return null;
  }

  getActiveViewOfType<T extends View>(_type: new (...args: any[]) => T): T | null {
    return null;
  }

  on(name: string, callback: (...args: any[]) => void): () => void {
    super.on(name, callback);
    return () => this.off(name, callback);
  }

  trigger(name: string, ...args: any[]): void {
    this.emit(name, ...args);
  }
}

export class WorkspaceLeaf {
  async setViewState(_state: unknown): Promise<void> {}
}

export class View {
  leaf!: WorkspaceLeaf;
}

export class App {
  appId = "";
  fileManager!: FileManager;
  metadataCache = new MetadataCache();
  vault!: Vault;
  workspace = new Workspace();
}

export class Plugin {
  app!: App;
  manifest: any = {};
  private unloaders: Array<() => void> = [];

  addCommand(_command: unknown): void {}
  addRibbonIcon(): void {}
  addSettingTab(): void {}
  register(callback: () => void): void {
    this.unloaders.push(callback);
  }
  registerDomEvent(): void {}
  registerEditorExtension(): void {}
  registerEvent(ref: (() => void) | undefined): void {
    if (typeof ref === "function") this.register(ref);
  }
  registerInterval(id: ReturnType<typeof setInterval>): void {
    this.register(() => clearInterval(id));
  }
  registerView(): void {}
  removeCommand(): void {}
  async loadData(): Promise<unknown> {
    return null;
  }
  async saveData(_data: unknown): Promise<void> {}
  onunload(): void {
    for (const unload of this.unloaders.splice(0).reverse()) unload();
  }
}

export class Modal {
  constructor(public app?: App) {}
  open(): void {}
  close(): void {}
}

export class MarkdownView {}
export class TextFileView {}
export class PluginSettingTab {
  constructor(public app: App, public plugin: Plugin) {}
}

export class Notice {
  constructor(public message: string, public timeout?: number) {
    if (timeout !== 0) console.warn(`[Relay Notice] ${message}`);
  }
}

export function normalizePath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function debounce<T extends (...args: any[]) => any>(fn: T, timeout = 0): T {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = function debounced(this: unknown, ...args: Parameters<T>) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, timeout);
  } as T & { cancel: () => void };
  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced as T;
}

export function requireApiVersion(_version: string): boolean {
  return true;
}

export function setIcon(_element: unknown, _icon: string): void {}

export function parseYaml(input: string): unknown {
  return yaml.load(input);
}

export function stringifyYaml(input: unknown): string {
  return yaml.dump(input);
}

export function getFrontMatterInfo(input: string): {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
} {
  if (!input.startsWith("---\n")) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const end = input.indexOf("\n---", 4);
  if (end < 0) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const contentStart = input.indexOf("\n", end + 4) + 1;
  return {
    exists: true,
    frontmatter: input.slice(4, end),
    from: 0,
    to: contentStart,
    contentStart,
  };
}

export const MarkdownRenderer = {
  async render(): Promise<void> {},
};

export const editorInfoField = {};

export type RequestUrlParam = {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
};

export type RequestUrlResponse = {
  arrayBuffer: ArrayBuffer;
  headers: Record<string, string>;
  json: unknown;
  status: number;
  text: string;
};

export type RequestUrlResponsePromise = Promise<RequestUrlResponse>;

export async function requestUrl(input: string | RequestUrlParam): Promise<RequestUrlResponse> {
  const params = typeof input === "string" ? { url: input } : input;
  const response = await requestBinary(params.url, {
    method: params.method ?? "GET",
    headers: params.headers,
    body: params.body as BodyInit | undefined,
  });
  const arrayBuffer = response.arrayBuffer;
  const text = new TextDecoder().decode(arrayBuffer);
  const headers = response.headers;
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (params.throw !== false && !response.ok) {
    throw Object.assign(new Error(`Request failed with status ${response.status}: ${text}`), {
      status: response.status,
      response,
    });
  }
  return {
    arrayBuffer,
    headers,
    json,
    status: response.status,
    text,
  };
}

function momentFn(): Date {
  return new Date();
}
momentFn.now = () => Date.now();
export const moment = momentFn;
