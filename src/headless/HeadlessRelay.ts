import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { App, TFile, TFolder, normalizePath, type TAbstractFile } from "./obsidian-shim";
import { installLogRouting, runWithLogSink } from "./log-context";
import { createHeadlessLoginManager } from "./HeadlessAuth";
import { FileSystemVault, type InternalWriteInfo } from "./FileSystemVault";
import {
  FeatureFlagDefaults,
  type FeatureFlags,
} from "../../vendor/relay/src/flags";
import { FeatureFlagManager } from "../../vendor/relay/src/flagManager";
import { DefaultTimeProvider, type TimeProvider } from "../../vendor/relay/src/TimeProvider";
import { Settings, NamespacedSettings, type StorageAdapter } from "../../vendor/relay/src/SettingsStorage";
import { EndpointManager, type EndpointSettings } from "../../vendor/relay/src/EndpointManager";
import { LoginManager, type LoginSettings } from "../../vendor/relay/src/LoginManager";
import { RelayManager } from "../../vendor/relay/src/RelayManager";
import type { RemoteSharedFolder } from "../../vendor/relay/src/Relay";
import { LiveTokenStore } from "../../vendor/relay/src/LiveTokenStore";
import { DeviceManager } from "../../vendor/relay/src/DeviceManager";
import { BackgroundSync } from "../../vendor/relay/src/BackgroundSync";
import {
  isDocument,
  type Document,
} from "../../vendor/relay/src/Document";
import { SharedFolder, SharedFolders, type SharedFolderSettings } from "../../vendor/relay/src/SharedFolder";
import { HSMStore } from "../../vendor/relay/src/merge-hsm/persistence";
import { ContentAddressedFileStore, isSyncFile } from "../../vendor/relay/src/SyncFile";
import { registerRelayCliHandlers } from "./RelayCli";
import { RelayDebugAPI } from "../../vendor/relay/src/RelayDebugAPI";
import { isCanvas } from "../../vendor/relay/src/Canvas";
import { isDestroyedError } from "../../vendor/relay/src/DestroyedError";
import { isRetryableS3Error } from "../../vendor/relay/src/S3Error";
import {
  initializeLogger,
  RelayInstances,
  setDebugging,
  curryLog,
} from "../../vendor/relay/src/debug";
import {
  setDeviceManagementConfig,
  setPluginRequestConfig,
} from "../../vendor/relay/src/customFetch";
import { SyncSettingsManager } from "../../vendor/relay/src/SyncSettings";
import {
  ActiveEditorSession,
  type ActiveEditorApplyResult,
  type ActiveEditorFrame,
} from "./ActiveEditorSession";
import {
  clearStoredLogin,
  updateStoredLoginToken,
} from "./auth-storage";

type CliData = Record<string, string | "true">;
type CliHandler = (params: CliData) => string | Promise<string>;
type InternalFilesystemMarker = InternalWriteInfo & { until: number };
type LoggingStatus = {
  debugging: boolean;
  network: boolean;
  logPath: string;
  settingsPath: string;
};
export type DeletionGateStatus = {
  gated: boolean;
  token: string | null;
  gatedAt: number | null;
  paths: string[];
};
export type DeletionGateResolution = {
  result: "resolved" | "not-gated" | "stale";
  gate: DeletionGateStatus;
};

interface RelaySettings extends FeatureFlags {
  debugging: boolean;
  endpoints: EndpointSettings;
  login?: LoginSettings;
  release: { channel: string };
  sharedFolders: SharedFolderSettings[];
}

const DEFAULT_SETTINGS: RelaySettings = {
  ...FeatureFlagDefaults,
  debugging: false,
  endpoints: {},
  release: { channel: "stable" },
  sharedFolders: [],
};

class JsonStorage<T> implements StorageAdapter<T> {
  private saveCounter = 0;
  private saveQueue = Promise.resolve();

  constructor(private file: string) {}

  async loadData(): Promise<T | null> {
    try {
      const text = await fs.readFile(this.file, "utf8");
      if (!text.trim()) return null;
      return JSON.parse(text) as T;
    } catch (error: any) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async saveData(data: T): Promise<void> {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    this.saveQueue = this.saveQueue
      .catch(() => {})
      .then(() => this.writeSerialized(serialized));
    await this.saveQueue;
  }

  private async writeSerialized(serialized: string): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${this.saveCounter++}`;
    await fs.writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
    if (process.platform !== "win32") await fs.chmod(this.file, 0o600);
  }
}

export class HeadlessRelay {
  app: App;
  appId: string;
  backgroundSync!: BackgroundSync;
  debug = curryLog("[RelayHeadless]", "debug");
  deviceManager!: DeviceManager;
  endpointSettings!: NamespacedSettings<EndpointSettings>;
  folderSettings!: NamespacedSettings<SharedFolderSettings[]>;
  hashStore!: ContentAddressedFileStore;
  loginManager!: LoginManager;
  loginSettings!: NamespacedSettings<LoginSettings>;
  relayManager!: RelayManager;
  relayDebugAPI!: RelayDebugAPI;
  settings!: Settings<RelaySettings>;
  sharedFolders!: SharedFolders;
  timeProvider!: TimeProvider;
  tokenStore!: LiveTokenStore;

  private cliHandlers = new Map<string, CliHandler>();
  private activeEditors = new Map<string, ActiveEditorSession>();
  private activeEditorDocuments = new Map<string, string>();
  private openingEditorGuids = new Set<string>();
  private hsmStore!: HSMStore;
  private logSinkId: string | null = null;
  private pendingVaultDeletes: Array<{ path: string; isFolder: boolean }> = [];
  private pendingVaultDeleteFlush: number | null = null;
  private internalFilesystemEvents = new Map<string, InternalFilesystemMarker>();
  private processedFilesystemEvents = 0;
  private suppressedFilesystemEvents = 0;
  private relayDebugGlobal: any;
  private releaseSettings!: NamespacedSettings<{ channel: string }>;
  private sharedFolderVaultPath: string;
  private unloaders: Array<() => void> = [];
  private vault: FileSystemVault;

  constructor(
    private input: {
      authoritative?: boolean;
      folderGuid: string;
      folderPath: string;
      relayId?: string | null;
      server?: string;
      stateDir: string;
    },
  ) {
    const folderPath = path.resolve(input.folderPath);
    const vaultRoot = path.dirname(folderPath);
    const vaultName = path.basename(folderPath) || "Relay";
    this.sharedFolderVaultPath = vaultName;
    this.appId = stableId(input.folderGuid, folderPath);
    const vault = new FileSystemVault(
      vaultRoot,
      vaultName,
      (info) => this.markInternalFilesystemEvent(info),
      folderPath,
    );
    this.vault = vault;
    const app = new App();
    app.appId = this.appId;
    app.vault = vault;
    app.fileManager = vault.fileManager;
    this.app = app;
  }

  registerCliHandler(
    command: string,
    _description: string,
    _flags: unknown,
    handler: CliHandler,
  ): void {
    this.cliHandlers.set(command, handler);
  }

  register(callback: () => void): void {
    this.unloaders.push(callback);
  }

  registerEvent(ref: (() => void) | undefined): void {
    if (typeof ref === "function") this.register(ref);
  }

  /**
   * Run FN inside this runtime's log-sink context so every log line emitted
   * from its call tree (including async continuations, timers, and provider
   * callbacks created within it) lands in this folder's relay.log even when
   * several runtimes share the process.
   */
  private withLogSink<T>(fn: () => T): T {
    return this.logSinkId !== null ? runWithLogSink(this.logSinkId, fn) : fn();
  }

  async start(): Promise<void> {
    setPluginRequestConfig({ pluginId: "system3-relay" });
    setDebugging(false);
    this.timeProvider = new DefaultTimeProvider();
    installLogRouting();
    this.logSinkId = initializeLogger(
      this.app.vault.adapter,
      this.timeProvider,
      `${this.sharedFolderVaultPath}/.relay/relay.log`,
      { disableConsole: false },
    );
    return this.withLogSink(() => this.startRuntime());
  }

  private async startRuntime(): Promise<void> {
    RelayInstances.set(this, "headless-plugin");

    this.settings = new Settings(
      new JsonStorage<RelaySettings>(path.join(this.input.stateDir, "plugin-data.json")),
      DEFAULT_SETTINGS,
    );
    await this.settings.load();
    await this.applyHeadlessRuntimeSettings();
    await this.ensureSharedFolderSetting();
    await this.settings.save();
    setDebugging(this.settings.get().debugging === true);

    this.folderSettings = new NamespacedSettings(this.settings, "sharedFolders");
    this.releaseSettings = new NamespacedSettings(this.settings, "release");
    this.loginSettings = new NamespacedSettings(this.settings, "login");
    this.endpointSettings = new NamespacedSettings(this.settings, "endpoints");

    FeatureFlagManager.getInstance().setSettings(
      new NamespacedSettings(this.settings, "(enable*)"),
    );

    const endpointManager = new EndpointManager(this.endpointSettings);
    this.loginManager = await createHeadlessLoginManager(
      this.app.vault.getName(),
      this.input.server,
      endpointManager,
      this.timeProvider,
      this.loginSettings,
    );
    if (!this.loginManager.authStore.isValid) {
      clearStoredLogin();
    }
    this.register(this.loginManager.authStore.onChange((token) => {
      if (token) {
        updateStoredLoginToken(token, endpointManager.getAuthUrl());
      } else {
        clearStoredLogin();
      }
    }));
    this.relayManager = new RelayManager(this.loginManager);
    this.deviceManager = new DeviceManager(this.appId, this.loginManager);
    const deviceId = this.settings.get().enableDeviceManagement
      ? this.deviceManager.getDeviceId()
      : "";
    if (deviceId) {
      setDeviceManagementConfig({
        vaultId: this.appId,
        deviceId,
      });
    }

    this.hsmStore = new HSMStore(this.appId);
    this.hashStore = new ContentAddressedFileStore(this.appId);
    this.tokenStore = new LiveTokenStore(
      this.loginManager,
      this.timeProvider,
      this.app.vault.getName(),
      deviceId,
      3,
      "relay-cli",
    );
    this.sharedFolders = new SharedFolders(
      this.relayManager,
      this.app.vault as any,
      this.createSharedFolder.bind(this),
      this.folderSettings,
      this.hsmStore,
    );
    this.backgroundSync = new BackgroundSync(
      this.loginManager,
      this.timeProvider,
      this.sharedFolders,
      3,
    );

    this.loginManager.setup();
    await this.ensureAuthoritativeRemoteFolderRecord();
    if (this.settings.get().enableDeviceManagement) {
      this.deviceManager.register();
    }
    this.relayDebugAPI = new RelayDebugAPI(this);
    this.relayDebugGlobal = (globalThis as any).window?.__relayDebug;
    // Index the vault before any upstream code loads: Obsidian's vault is
    // fully populated before plugins run, and SharedFolder traversals must
    // see the same model that events will mutate.
    this.vault.rememberTree(this.sharedFolderVaultPath);
    this.sharedFolders.load();
    await this.ensureAuthoritativeRemoteFolder();
    this.setupVaultEventHandlers();
    this.tokenStore.start();
    this.backgroundSync.start();
    registerRelayCliHandlers(this as any);
  }

  async stop(): Promise<void> {
    return this.withLogSink(() => this.stopRuntime());
  }

  private async stopRuntime(): Promise<void> {
    await Promise.all(
      [...this.activeEditors.values()].map((session) =>
        session.close().catch((error) => {
          this.debug(`Failed to close active editor ${session.id}`, error);
        }),
      ),
    );
    this.activeEditors.clear();
    this.activeEditorDocuments.clear();
    this.openingEditorGuids.clear();
    for (const unload of this.unloaders.splice(0).reverse()) unload();
    this.backgroundSync?.destroy?.();
    this.tokenStore?.stop();
    this.sharedFolders?.destroy();
    this.relayDebugAPI?.destroy?.();
    this.hsmStore?.destroy?.();
    this.hashStore?.destroy?.();
    this.relayManager?.destroy?.();
    this.deviceManager?.destroy?.();
    this.loginManager?.destroy?.();
    this.timeProvider?.destroy();
    this.internalFilesystemEvents.clear();
  }

  async waitForStartup(): Promise<void> {
    if (!this.sharedFolders) return;
    await this.withLogSink(() =>
      Promise.all(this.sharedFolders.items().map((folder) => folder.whenSynced())),
    );
  }

  async handleFilesystemEvent(event: { type: "rename" | "change" | "move"; path: string; oldPath?: string }): Promise<void> {
    return this.withLogSink(() => this.handleFilesystemEventRouted(event));
  }

  private async handleFilesystemEventRouted(event: { type: "rename" | "change" | "move"; path: string; oldPath?: string }): Promise<void> {
    const relativePath = normalizePath(event.path);
    const targetsRoot = event.path === "/" || !relativePath;
    if (!relativePath && !targetsRoot) return;
    const vaultPath = targetsRoot
      ? this.sharedFolderVaultPath
      : normalizePath(`${this.sharedFolderVaultPath}/${relativePath}`);
    if (event.type === "move" && event.oldPath) {
      const oldRelativePath = normalizePath(event.oldPath);
      if (!oldRelativePath) return;
      const oldVaultPath = normalizePath(`${this.sharedFolderVaultPath}/${oldRelativePath}`);
      const newInternalEcho = await this.isInternalFilesystemEcho(vaultPath);
      const oldInternalEcho = await this.isInternalFilesystemEcho(oldVaultPath);
      if (newInternalEcho && oldInternalEcho) {
        this.suppressedFilesystemEvents += 1;
        return;
      }
      this.processedFilesystemEvents += 1;
      await this.vault.refreshAndTrigger("rename", vaultPath, oldVaultPath);
      return;
    }

    if (await this.isInternalFilesystemEcho(vaultPath)) {
      this.suppressedFilesystemEvents += 1;
      return;
    }
    this.processedFilesystemEvents += 1;
    if (event.type === "change") {
      await this.vault.refreshAndTrigger("modify", vaultPath);
      return;
    }

    const existing = this.vault.getAbstractFileByPath(vaultPath);
    await this.vault.refreshAndTrigger(existing ? "create" : "delete", vaultPath);
  }

  private markInternalFilesystemEvent(info: InternalWriteInfo): void {
    const vaultPath = normalizePath(info.vaultPath);
    if (!vaultPath) return;
    this.internalFilesystemEvents.set(vaultPath, {
      ...info,
      vaultPath,
      until: Date.now() + 10_000,
    });
  }

  private async isInternalFilesystemEcho(vaultPath: string): Promise<boolean> {
    const normalized = normalizePath(vaultPath);
    const now = Date.now();
    let matchedMissingAncestor = false;

    for (const [markedPath, marker] of [...this.internalFilesystemEvents]) {
      if (marker.until < now) {
        this.internalFilesystemEvents.delete(markedPath);
        continue;
      }
      if (markedPath === normalized) {
        return await this.currentFilesystemStateMatches(normalized, marker);
      }
      if (!marker.exists && normalized.startsWith(`${markedPath}/`)) {
        matchedMissingAncestor = true;
      }
    }

    if (!matchedMissingAncestor) return false;
    const current = await this.vault.adapter.stat(normalized);
    return current === null;
  }

  private async currentFilesystemStateMatches(
    vaultPath: string,
    marker: InternalFilesystemMarker,
  ): Promise<boolean> {
    const current = await this.vault.adapter.stat(vaultPath);
    if (!marker.exists) return current === null;
    if (!current) return false;
    if (marker.kind === "file" && marker.stats) {
      return current.size === marker.stats.size && current.mtime === marker.stats.mtime;
    }
    return marker.kind === "folder";
  }

  async invoke(command: string, params: CliData = {}): Promise<string> {
    const handler = this.cliHandlers.get(command);
    if (!handler) throw new Error(`Unknown Relay CLI handler: ${command}`);
    return await this.withLogSink(() => handler(params));
  }

  async invokeDebug(method: string, params: unknown[] = []): Promise<unknown> {
    return this.withLogSink(() => this.invokeDebugRouted(method, params));
  }

  private async invokeDebugRouted(method: string, params: unknown[] = []): Promise<unknown> {
    const debugWindow = (globalThis as any).window;
    const debugApi = this.relayDebugGlobal ?? debugWindow?.__relayDebug;
    const fn = debugApi?.[method];
    if (typeof fn !== "function") {
      throw new Error(`RelayDebugAPI method not found: ${method}`);
    }
    const previousDebugGlobal = debugWindow?.__relayDebug;
    if (debugWindow && debugApi) {
      debugWindow.__relayDebug = debugApi;
    }
    try {
      return await fn(...params);
    } finally {
      if (debugWindow) {
        debugWindow.__relayDebug = previousDebugGlobal;
      }
    }
  }

  status(): unknown {
    return this.withLogSink(() => this.statusRouted());
  }

  deletionGateStatus(): DeletionGateStatus {
    return this.withLogSink(() => this.deletionGateStatusRouted());
  }

  resolveDeletionGate(
    decision: "send" | "restore",
    token: string,
  ): DeletionGateResolution {
    return this.withLogSink(() => {
      const folder = this.primarySharedFolder() as any;
      const result = decision === "send"
        ? folder?.sendHeldDeletions?.(token) ?? "not-gated"
        : folder?.restoreHeldDeletions?.(token) ?? "not-gated";
      return { result, gate: this.deletionGateStatusRouted() };
    });
  }

  private statusRouted(): unknown {
    return {
      appId: this.appId,
      folder: this.input.folderPath,
      logging: this.loggingStatus(),
      login: {
        loggedIn: this.loginManager?.loggedIn ?? false,
      },
      folders: this.sharedFolders
        ? this.sharedFolders.items().map((folder) => ({
            guid: folder.guid,
            path: folder.path,
            connected: folder.connected,
            relay: folder.relayId ?? null,
            provider: {
              state: (folder as any).state ?? null,
              synced: (folder as any).synced ?? false,
              wsReadyState: (folder as any)._provider?.ws?.readyState ?? null,
              eventSubscriptions: [...((folder as any)._provider?.eventSubscriptions ?? [])],
              committedSubdocGuids: (folder as any).syncStore?.getCommittedSubdocGuids?.() ?? [],
              lastSubdocIndexKeys: Object.keys((folder as any)._provider?.lastSubdocIndex ?? {}),
            },
            files: this.describeFolderFiles(folder as any),
            metas: this.describeFolderMetas(folder as any),
            pendingUpload: [...((folder as any).syncStore?.pendingUpload?.entries?.() ?? [])],
            folderSync: (folder as any).getFolderSyncSnapshot?.() ?? null,
            deletionGate: this.projectDeletionGate((folder as any).deletionGate?.() ?? null),
          }))
        : [],
      queue: this.backgroundSync?.getQueueStatus(),
      filesystemEvents: {
        processed: this.processedFilesystemEvents,
        suppressed: this.suppressedFilesystemEvents,
        internalMarkers: this.internalFilesystemEvents.size,
      },
      activeEditors: [...this.activeEditors.values()].map((session) => ({
        sessionId: session.id,
        guid: session.guid,
        path: session.path,
      })),
    };
  }

  async openActiveEditor(input: {
    path: string;
    user?: {
      id?: string;
      name?: string;
      color?: string;
      colorLight?: string;
    };
  }): Promise<ActiveEditorFrame> {
    return this.withLogSink(async () => {
      if (!input || typeof input.path !== "string" || !input.path.trim()) {
        throw new Error("Active editor requires a document path.");
      }
      const { document, vaultPath } = this.resolveActiveEditorDocument(input.path);
      if (
        this.openingEditorGuids.has(document.guid) ||
        this.activeEditorDocuments.has(document.guid)
      ) {
        throw new Error(`An active editor is already registered for ${vaultPath}`);
      }

      this.openingEditorGuids.add(document.guid);
      try {
        const session = await ActiveEditorSession.open(
          document,
          `/${vaultPath}`,
          input.user,
        );
        this.activeEditors.set(session.id, session);
        this.activeEditorDocuments.set(session.guid, session.id);
        return session.frame();
      } finally {
        this.openingEditorGuids.delete(document.guid);
      }
    });
  }

  activeEditorFrame(sessionId: string): ActiveEditorFrame {
    return this.withLogSink(() => this.requireActiveEditor(sessionId).frame());
  }

  applyActiveEditor(
    sessionId: string,
    input: {
      baseText: string;
      desiredText: string;
      cursor?: number | null;
      selection?: { anchor: number; head: number } | null;
    },
  ): ActiveEditorApplyResult {
    return this.withLogSink(() => {
      if (
        !input ||
        typeof input.baseText !== "string" ||
        typeof input.desiredText !== "string"
      ) {
        throw new Error("Active editor apply requires baseText and desiredText.");
      }
      return this.requireActiveEditor(sessionId).apply(input);
    });
  }

  async closeActiveEditor(sessionId: string): Promise<void> {
    return this.withLogSink(async () => {
      const session = this.requireActiveEditor(sessionId);
      this.activeEditors.delete(sessionId);
      this.activeEditorDocuments.delete(session.guid);
      await session.close();
    });
  }

  private requireActiveEditor(sessionId: string): ActiveEditorSession {
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Active editor sessionId is required.");
    }
    const session = this.activeEditors.get(sessionId);
    if (!session) throw new Error(`Active editor session not found: ${sessionId}`);
    return session;
  }

  private resolveActiveEditorDocument(requestedPath: string): {
    document: Document;
    vaultPath: string;
  } {
    const folderRoot = path.resolve(this.input.folderPath);
    const requestedAbsolute = path.resolve(requestedPath);
    let relativePath: string;
    if (
      requestedAbsolute === folderRoot ||
      requestedAbsolute.startsWith(`${folderRoot}${path.sep}`)
    ) {
      relativePath = path.relative(folderRoot, requestedAbsolute);
    } else {
      relativePath = requestedPath.replaceAll("\\", "/").replace(/^\/+/, "");
      if (
        relativePath === this.sharedFolderVaultPath ||
        relativePath.startsWith(`${this.sharedFolderVaultPath}/`)
      ) {
        relativePath = relativePath.slice(this.sharedFolderVaultPath.length);
      }
    }
    relativePath = normalizePath(relativePath).replace(/^\/+/, "");
    if (!relativePath || relativePath.startsWith("../")) {
      throw new Error(`Active editor path is outside the Relay folder: ${requestedPath}`);
    }

    const vaultPath = normalizePath(
      `${this.sharedFolderVaultPath}/${relativePath}`,
    );
    const folder = this.sharedFolders.lookup(vaultPath);
    if (!folder) {
      throw new Error(`Active editor path is not in a shared folder: ${requestedPath}`);
    }
    const document = folder.proxy.getDoc(vaultPath);
    if (!isDocument(document)) {
      throw new Error(`Active editor path is not a text document: ${requestedPath}`);
    }
    return { document, vaultPath };
  }

  private primarySharedFolder(): SharedFolder | null {
    return this.sharedFolders?.find((folder) => folder.guid === this.input.folderGuid) ?? null;
  }

  private deletionGateStatusRouted(): DeletionGateStatus {
    return this.projectDeletionGate((this.primarySharedFolder() as any)?.deletionGate?.() ?? null);
  }

  private projectDeletionGate(
    gate: { token: string; gatedAt: number; paths: string[] } | null,
  ): DeletionGateStatus {
    return {
      gated: gate !== null,
      token: gate?.token ?? null,
      gatedAt: gate?.gatedAt ?? null,
      paths: gate?.paths ?? [],
    };
  }

  async configureLogging(input: { debugging?: boolean; network?: boolean }): Promise<LoggingStatus> {
    return this.withLogSink(() => this.configureLoggingRouted(input));
  }

  private async configureLoggingRouted(input: { debugging?: boolean; network?: boolean }): Promise<LoggingStatus> {
    await this.settings.load();
    await this.settings.update((settings) => {
      const next: RelaySettings = { ...settings };
      if (input.debugging !== undefined) next.debugging = input.debugging;
      if (input.network !== undefined) {
        next.enableNetworkLogging = input.network;
        if (input.network) next.debugging = true;
      }
      return next;
    });
    await this.settings.load();
    const settings = this.settings.get();
    setDebugging(settings.debugging === true);
    const featureFlags = FeatureFlagManager.getInstance();
    featureFlags.flags = {
      ...featureFlags.flags,
      enableNetworkLogging: settings.enableNetworkLogging === true,
    };
    featureFlags.notifyListeners();
    return this.loggingStatus();
  }

  loggingStatus(): LoggingStatus {
    const settings = this.settings?.get?.() ?? DEFAULT_SETTINGS;
    return {
      debugging: settings.debugging === true,
      network: settings.enableNetworkLogging === true,
      logPath: path.join(this.input.folderPath, ".relay", "relay.log"),
      settingsPath: path.join(this.input.stateDir, "plugin-data.json"),
    };
  }

  private describeFolderFiles(folder: any): unknown[] {
    return [...(folder.files?.values?.() ?? [])].map((file: any) => {
      let stat = null;
      try {
        stat = file.stat ?? null;
      } catch {}
      return {
        guid: file.guid ?? null,
        path: file.path ?? null,
        kind: file.constructor?.name ?? null,
        tag: file.tag ?? null,
        pending: file.pending ?? null,
        uploadError: file.uploadError ?? null,
        meta: file.meta ?? folder.syncStore?.getMeta?.(file.path) ?? null,
        stat,
      };
    });
  }

  private describeFolderMetas(folder: any): unknown[] {
    const rows: Array<{ meta: unknown; path: string }> = [];
    folder.syncStore?.forEachWithPending?.((meta: unknown, path: string) => {
      rows.push({ path, meta });
    });
    return rows.sort((left, right) => left.path.localeCompare(right.path));
  }

  private createSharedFolder(
    folderPath: string,
    guid: string,
    relayId?: string,
    authoritative?: boolean,
    remote?: RemoteSharedFolder,
  ): SharedFolder {
    const folderSettings = new NamespacedSettings<SharedFolderSettings>(
      this.settings,
      `sharedFolders/[guid=${guid}]`,
    );
    folderSettings.update((current) => ({
      ...current,
      path: folderPath,
      guid,
      ...(relayId ? { relay: relayId } : {}),
      sync: current.sync ?? SyncSettingsManager.defaultFlags,
    }), true);

    return new SharedFolder(
      this.appId,
      guid,
      folderPath,
      this.loginManager,
      this.app.vault as any,
      this.app.metadataCache as any,
      this.app.fileManager as any,
      this.tokenStore,
      this.relayManager,
      this.hashStore,
      this.backgroundSync,
      folderSettings,
      this.hsmStore,
      this.timeProvider,
      relayId,
      authoritative ?? (guid === this.input.folderGuid && this.input.authoritative === true),
      remote,
    );
  }

  private async ensureAuthoritativeRemoteFolder(): Promise<void> {
    if (!this.input.authoritative || !this.input.relayId || !this.loginManager.loggedIn) {
      return;
    }
    const folder = this.sharedFolders.find((candidate) => candidate.guid === this.input.folderGuid);
    if (!folder) return;

    await this.relayManager.update();
    if (folder.remote) {
      folder.shouldConnect = true;
      folder.connect();
      return;
    }

    const relay = this.relayManager.relays
      .values()
      .find((candidate) => candidate.guid === this.input.relayId);
    if (!relay) throw new Error(`Relay not found: ${this.input.relayId}`);

    let remote = this.findRemoteFolderForCurrentFolder();
    if (!remote) {
      try {
        remote = await this.relayManager.createRemoteFolder(
          folder.guid,
          folder.name,
          relay,
          false,
        );
      } catch (error) {
        await this.relayManager.update();
        remote = this.findRemoteFolderForCurrentFolder();
        if (!remote) throw error;
      }
    }
    folder.remote = remote;
    folder.shouldConnect = true;
    folder.connect();
    this.sharedFolders.notifyListeners();
  }

  private async ensureAuthoritativeRemoteFolderRecord(): Promise<void> {
    if (!this.input.authoritative || !this.input.relayId || !this.loginManager.loggedIn) {
      return;
    }

    await this.relayManager.update();
    if (this.findRemoteFolderForCurrentFolder()) return;

    const relay = this.relayManager.relays
      .values()
      .find((candidate) => candidate.guid === this.input.relayId);
    if (!relay) throw new Error(`Relay not found: ${this.input.relayId}`);

    try {
      await this.relayManager.createRemoteFolder(
        this.input.folderGuid,
        path.basename(this.input.folderPath) || "Relay Folder",
        relay,
        false,
      );
    } catch (error) {
      await this.relayManager.update();
      if (!this.findRemoteFolderForCurrentFolder()) throw error;
    }
  }

  private findRemoteFolderForCurrentFolder(): any | null {
    return this.relayManager.remoteFolders
      .values()
      .find((remote) => (
        remote.guid === this.input.folderGuid &&
        remote.relay?.guid === this.input.relayId
      )) ?? null;
  }

  private queueVaultDelete(
    file: TAbstractFile,
    vaultLog: (...args: unknown[]) => void,
  ): void {
    this.pendingVaultDeletes.push({
      path: file.path,
      isFolder: file instanceof TFolder,
    });
    if (this.pendingVaultDeleteFlush !== null) return;
    this.pendingVaultDeleteFlush = this.timeProvider.setTimeout(() => {
      this.pendingVaultDeleteFlush = null;
      this.flushVaultDeletes(vaultLog);
    }, 0);
  }

  private flushVaultDeletes(vaultLog: (...args: unknown[]) => void): void {
    const events = this.pendingVaultDeletes;
    this.pendingVaultDeletes = [];
    if (events.length === 0) return;

    const removedSharedRoots: Array<{ folder: SharedFolder; path: string }> = [];
    for (const event of events) {
      if (!event.isFolder) continue;
      const folder = this.sharedFolders.find((candidate) => candidate.path === event.path);
      if (folder && !removedSharedRoots.some((entry) => entry.folder === folder)) {
        removedSharedRoots.push({ folder, path: folder.path });
      }
    }
    for (const { folder } of removedSharedRoots) {
      this.sharedFolders.delete(folder);
    }

    const isUnderRemovedSharedRoot = (filePath: string): boolean => (
      removedSharedRoots.some((root) => (
        filePath === root.path || filePath.startsWith(`${root.path}/`)
      ))
    );
    const batches = new Map<SharedFolder, { files: Set<string>; folders: Set<string> }>();
    for (const event of events) {
      if (isUnderRemovedSharedRoot(event.path)) continue;
      const folder = this.sharedFolders.lookup(event.path);
      if (!folder) continue;
      const vpath = folder.getVirtualPath(event.path);
      if (folder.consumePendingDelete(vpath)) continue;
      vaultLog("Delete", event.path);
      let batch = batches.get(folder);
      if (!batch) {
        batch = { files: new Set(), folders: new Set() };
        batches.set(folder, batch);
      }
      (event.isFolder ? batch.folders : batch.files).add(vpath);
    }

    for (const [folder, batch] of batches) {
      const deletePaths = folder
        .expandDeletePaths(batch.files, batch.folders)
        .filter((vpath) => !folder.isPendingDelete(vpath));
      if (deletePaths.length === 0) continue;
      deletePaths.forEach((vpath) => folder.markPendingDelete(vpath));
      void folder.whenReady()
        .then((readyFolder) => {
          if (!readyFolder.destroyed) readyFolder.deleteFiles(deletePaths);
        })
        .catch((error) => {
          if (!isDestroyedError(error)) vaultLog("Vault delete failed", error);
        })
        .finally(() => {
          deletePaths.forEach((vpath) => folder.clearPendingDelete(vpath));
        });
    }
  }

  private setupVaultEventHandlers(): void {
    const vaultLog = curryLog("[System 3][Relay][Vault][Headless]", "log");

    this.registerEvent(
      this.app.vault.on("create", (tfile) => {
        const folder = this.sharedFolders.lookup(tfile.path);
        if (!folder) return;
        vaultLog("Create", tfile.path);
        if (folder.notifyVaultCreateLegacy(tfile)) {
          void folder.whenReady()
            .then((readyFolder) => {
              readyFolder.getFile(tfile);
            })
            .catch((error) => {
              if (!isDestroyedError(error)) vaultLog("Folder ready failed after file create", error);
            });
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.queueVaultDelete(file, vaultLog);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder) {
          const sharedFolder = this.sharedFolders.find((folder) => folder.path === oldPath);
          if (sharedFolder) {
            sharedFolder.move(file.path);
            this.sharedFolders.update();
            return;
          }
        }
        const fromFolder = this.sharedFolders.lookup(oldPath);
        const toFolder = this.sharedFolders.lookup(file.path);
        if (fromFolder && toFolder && fromFolder === toFolder) {
          vaultLog("Rename", file.path, oldPath);
          fromFolder.notifyVaultRename(file, oldPath);
          return;
        }
        const folder = fromFolder || toFolder;
        if (fromFolder && toFolder) {
          vaultLog("Rename", file.path, oldPath);
          fromFolder.renameFile(file, oldPath);
          toFolder.renameFile(file, oldPath);
        } else if (folder) {
          vaultLog("Rename", file.path, oldPath);
          folder.renameFile(file, oldPath);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", async (tfile) => {
        const folder = this.sharedFolders.lookup(tfile.path);
        if (!folder) return;
        vaultLog("Modify", tfile.path);
        const file = folder.proxy.getFile(tfile);
        if (file && isSyncFile(file)) {
          if (!(tfile instanceof TFile)) {
            vaultLog("Skipping SyncFile modify -- event did not receive a TFile", tfile.path);
          } else {
            file.noteLocalModify(tfile.stat);
            void file.sync().catch((error) => {
              if (isRetryableS3Error(error)) {
                void folder.backgroundSync.enqueueRetryableSync(file, error).catch((retryError) => {
                  vaultLog("Binary file retry failed", retryError);
                });
                return;
              }
              vaultLog("Binary file sync failed", error);
            });
          }
        }

        if (
          file &&
          isDocument(file) &&
          file.hsm &&
          tfile instanceof TFile
        ) {
          try {
            await file.handleDiskChange();
          } catch (error) {
            vaultLog("Failed to send DISK_CHANGED to HSM", error);
          }
        }

        if (file && isCanvas(file) && tfile instanceof TFile) {
          try {
            if (file.isMaterialized) {
              file.hsm.send({ type: "DISK_CHANGED" });
            } else {
              folder.mergeManager?.wakeManagedFile(file.guid);
            }
          } catch (error) {
            vaultLog("Failed to send DISK_CHANGED to canvas", error);
          }
        }

        this.timeProvider.setTimeout(() => {
          this.app.metadataCache.trigger("resolve", tfile);
        }, 10);
      }),
    );
  }

  private async ensureSharedFolderSetting(): Promise<void> {
    const current = this.settings.get();
    const folderPath = path.basename(this.input.folderPath);
    const shouldConnect = this.input.authoritative === true ? false : true;
    const existing = current.sharedFolders.find((folder) => folder.guid === this.input.folderGuid);
    if (existing) {
      const relay = this.input.relayId ?? undefined;
      if (
        existing.path === folderPath &&
        existing.relay === relay &&
        existing.connect === shouldConnect &&
        existing.sync
      ) {
        return;
      }
      await this.settings.update((settings) => ({
        ...settings,
        sharedFolders: settings.sharedFolders.map((folder) => (
          folder.guid === this.input.folderGuid
            ? {
                ...folder,
                path: folderPath,
                relay,
                connect: shouldConnect,
                sync: folder.sync ?? SyncSettingsManager.defaultFlags,
              }
            : folder
        )),
      }));
      return;
    }
    await this.settings.update((settings) => ({
      ...settings,
      sharedFolders: [
        ...settings.sharedFolders,
        {
          guid: this.input.folderGuid,
          path: folderPath,
          relay: this.input.relayId ?? undefined,
          connect: shouldConnect,
          sync: SyncSettingsManager.defaultFlags,
        },
      ],
    }));
  }

  private async applyHeadlessRuntimeSettings(): Promise<void> {
    // Endpoint selection belongs to the build. Ignore saved plugin enterprise
    // tenant settings so they cannot redirect this headless runtime.
    await this.settings.update((settings) => ({ ...settings, endpoints: {} }));
    const env = (globalThis as any).process?.env as Record<string, string | undefined> | undefined;
    const enableDebug = env?.RELAY_HEADLESS_DEBUG === "1";
    const enableNetworkLogging = env?.RELAY_HEADLESS_NETWORK_LOGGING === "1";
    const disableDeviceManagement = env?.RELAY_HEADLESS_DEVICE_MANAGEMENT === "0";
    if (!enableDebug && !enableNetworkLogging && !disableDeviceManagement) return;

    await this.settings.update((settings) => ({
      ...settings,
      debugging: enableDebug || enableNetworkLogging || settings.debugging,
      ...(enableNetworkLogging ? { enableNetworkLogging: true } : {}),
      ...(disableDeviceManagement ? { enableDeviceManagement: false } : {}),
    }));
  }
}

function stableId(folderGuid: string, folderPath: string): string {
  const hash = createHash("sha1").update(`${folderGuid}:${folderPath}`).digest("hex").slice(0, 15);
  return `rcli${hash}`.slice(0, 15);
}
