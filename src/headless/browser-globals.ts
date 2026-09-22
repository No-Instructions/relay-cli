import { webcrypto } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Http2EventSource } from "./http2-eventsource";
import { installDurableIndexedDB } from "./sqlite-indexeddb";
import { openEncryptedDatabase } from "./encrypted-sqlite";
import {
  resolveStorageKey,
  StorageCipher,
  type StorageKeychain,
  type StorageKeyInput,
} from "./storage-crypto";

const unhandledRejectionKey = Symbol.for("relay.headless.unhandledRejectionInstalled");

class SqliteLocalStorage implements Storage {
  private db: DatabaseSync;

  constructor(dbPath: string, private cipher: StorageCipher) {
    this.db = openEncryptedDatabase(dbPath, cipher);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_storage (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      );
    `);
  }

  get length(): number {
    return this.db.prepare("SELECT COUNT(*) AS count FROM local_storage").get().count as number;
  }

  clear(): void {
    this.db.exec("DELETE FROM local_storage");
  }

  getItem(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM local_storage WHERE key = ?").get(key) as
      | { value: Uint8Array }
      | undefined;
    if (!row) return null;
    return this.cipher.decrypt(row.value, ["localStorage", key]).toString("utf8");
  }

  key(index: number): string | null {
    const row = this.db.prepare("SELECT key FROM local_storage ORDER BY key LIMIT 1 OFFSET ?").get(index) as { key: string } | undefined;
    return row?.key ?? null;
  }

  removeItem(key: string): void {
    this.db.prepare("DELETE FROM local_storage WHERE key = ?").run(key);
  }

  setItem(key: string, value: string): void {
    const encrypted = this.cipher.encrypt(Buffer.from(value, "utf8"), ["localStorage", key]);
    this.db.prepare(`
      INSERT INTO local_storage (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, encrypted);
  }
}

export async function installBrowserGlobals(input: {
  storageDbPath: string;
  storageKey?: StorageKeyInput;
  storageKeychain?: StorageKeychain;
}): Promise<void> {
  const global = globalThis as any;
  const storageKey = await resolveStorageKey({
    explicitKey: input.storageKey,
    keychain: input.storageKeychain,
    storageDbPath: input.storageDbPath,
  });
  const cipher = new StorageCipher(storageKey);
  if (!Array.prototype.remove) {
    Object.defineProperty(Array.prototype, "remove", {
      value(item: unknown) {
        const index = this.indexOf(item);
        if (index >= 0) this.splice(index, 1);
      },
      configurable: true,
    });
  }
  if (!(Array.prototype as any).contains) {
    Object.defineProperty(Array.prototype, "contains", {
      value(item: unknown) {
        return this.includes(item);
      },
      configurable: true,
    });
  }
  global.window ??= global;
  global.self ??= global;
  global.EventSource = Http2EventSource;
  global.navigator ??= { userAgent: "relay-cli/headless" };
  global.localStorage = new SqliteLocalStorage(input.storageDbPath, cipher);
  global.addEventListener ??= () => {};
  global.removeEventListener ??= () => {};
  global.crypto ??= webcrypto;
  installUnhandledRejectionBoundary(global);
  await installDurableIndexedDB(input.storageDbPath, cipher);
}

function installUnhandledRejectionBoundary(global: any): void {
  if (global[unhandledRejectionKey]) return;
  global[unhandledRejectionKey] = true;
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error
      ? (reason.stack ?? reason.message)
      : String(reason);
    console.error(`[RelayHeadless] Unhandled promise rejection: ${message}`);
  });
}
