import type { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import {
  IDBCursor,
  IDBCursorWithValue,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBOpenDBRequest,
  IDBRecord,
  IDBRequest,
  IDBTransaction,
  IDBVersionChangeEvent,
} from "fake-indexeddb";
import { openEncryptedDatabase } from "./encrypted-sqlite";
import type { StorageCipher } from "./storage-crypto";

type DatabaseInfo = { name: string; version: number };
type StoreInfo = {
  auto_increment: number;
  key_generator_num: number | null;
  key_path_json: string;
  name: string;
};
type RecordInfo = { key_hash: string; key_blob: Uint8Array; value_blob: Uint8Array };

export async function installDurableIndexedDB(
  storageDbPath: string,
  cipher: StorageCipher,
): Promise<void> {
  const global = globalThis as any;
  if (global.__relayDurableIndexedDBPath === storageDbPath && global.indexedDB) {
    return;
  }

  const storage = new IndexedDBSqliteStorage(storageDbPath, cipher);
  const factory = new IDBFactory() as IDBFactory & { _databases?: Map<string, any> };
  const installer = new DurableIndexedDB(factory, storage);
  installer.patch();

  Object.defineProperties(global, {
    indexedDB: descriptor(factory),
    IDBCursor: descriptor(IDBCursor),
    IDBCursorWithValue: descriptor(IDBCursorWithValue),
    IDBDatabase: descriptor(IDBDatabase),
    IDBFactory: descriptor(IDBFactory),
    IDBIndex: descriptor(IDBIndex),
    IDBKeyRange: descriptor(IDBKeyRange),
    IDBObjectStore: descriptor(IDBObjectStore),
    IDBOpenDBRequest: descriptor(IDBOpenDBRequest),
    IDBRecord: descriptor(IDBRecord),
    IDBRequest: descriptor(IDBRequest),
    IDBTransaction: descriptor(IDBTransaction),
    IDBVersionChangeEvent: descriptor(IDBVersionChangeEvent),
  });

  global.__relayDurableIndexedDBPath = storageDbPath;
  await installer.hydrate();
}

function descriptor(value: unknown): PropertyDescriptor {
  return {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  };
}

class DurableIndexedDB {
  private hydrating = false;
  private persistQueue = Promise.resolve();
  private patchedDbs = new WeakSet<IDBDatabase>();
  private patchedTransactions = new WeakSet<IDBTransaction>();

  constructor(
    private factory: IDBFactory & { _databases?: Map<string, any> },
    private storage: IndexedDBSqliteStorage,
  ) {}

  patch(): void {
    const originalOpen = this.factory.open.bind(this.factory);
    this.factory.open = ((name: string, version?: number) => {
      const request = originalOpen(name, version);
      request.addEventListener("success", () => {
        this.patchDatabase(request.result);
      });
      return request;
    }) as IDBFactory["open"];

    const originalDeleteDatabase = this.factory.deleteDatabase.bind(this.factory);
    this.factory.deleteDatabase = ((name: string) => {
      const request = originalDeleteDatabase(name);
      request.addEventListener("success", () => {
        this.storage.deleteDatabase(name);
      });
      return request;
    }) as IDBFactory["deleteDatabase"];
  }

  async hydrate(): Promise<void> {
    this.hydrating = true;
    try {
      for (const database of this.storage.listDatabases()) {
        await this.hydrateDatabase(database);
      }
    } finally {
      this.hydrating = false;
    }
  }

  private async hydrateDatabase(database: DatabaseInfo): Promise<void> {
    const stores = this.storage.listStores(database.name);
    const db = await requestToPromise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(database.name, database.version);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of stores) {
          if (db.objectStoreNames.contains(store.name)) continue;
          db.createObjectStore(store.name, {
            autoIncrement: store.auto_increment === 1,
            keyPath: JSON.parse(store.key_path_json),
          });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    this.patchDatabase(db);
    for (const store of stores) {
      const records = this.storage.listRecords(database.name, store.name);
      if (records.length === 0) continue;
      await transactionToPromise(db, [store.name], "readwrite", (tx) => {
        const objectStore = tx.objectStore(store.name);
        const keyPath = JSON.parse(store.key_path_json);
        for (const record of records) {
          const key = deserialize(this.storage.decryptRecord(
            database.name,
            store.name,
            record.key_hash,
            "key",
            record.key_blob,
          ));
          const value = deserialize(this.storage.decryptRecord(
            database.name,
            store.name,
            record.key_hash,
            "value",
            record.value_blob,
          ));
          if (keyPath === null) {
            objectStore.put(value, key);
          } else {
            objectStore.put(value);
          }
        }
      });
    }

    const rawDatabase = (db as any)._rawDatabase;
    for (const store of stores) {
      const rawStore = rawDatabase?.rawObjectStores?.get(store.name);
      if (rawStore?.keyGenerator && store.key_generator_num !== null) {
        rawStore.keyGenerator.num = store.key_generator_num;
      }
    }
    db.close();
  }

  private patchDatabase(db: IDBDatabase): void {
    if (this.patchedDbs.has(db)) return;
    this.patchedDbs.add(db);
    const originalTransaction = db.transaction.bind(db);
    db.transaction = ((storeNames: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions) => {
      const tx = originalTransaction(storeNames as any, mode, options);
      this.patchTransaction(tx);
      return tx;
    }) as IDBDatabase["transaction"];
  }

  private patchTransaction(tx: IDBTransaction): void {
    if (this.patchedTransactions.has(tx)) return;
    this.patchedTransactions.add(tx);
    if (tx.mode !== "readwrite" && tx.mode !== "versionchange") return;
    tx.addEventListener("complete", () => {
      if (this.hydrating) return;
      this.queuePersist(tx.db);
    });
  }

  private queuePersist(db: IDBDatabase): void {
    this.persistQueue = this.persistQueue
      .then(() => this.storage.persistDatabase(db))
      .catch((error) => {
        console.error(`[DurableIndexedDB] Failed to persist ${db.name}:`, error);
      });
  }
}

class IndexedDBSqliteStorage {
  private db: DatabaseSync;

  constructor(dbPath: string, private cipher: StorageCipher) {
    this.db = openEncryptedDatabase(dbPath, cipher);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS idb_databases (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idb_stores (
        db_name TEXT NOT NULL,
        name TEXT NOT NULL,
        key_path_json TEXT NOT NULL,
        auto_increment INTEGER NOT NULL,
        key_generator_num INTEGER,
        PRIMARY KEY (db_name, name)
      );
      CREATE TABLE IF NOT EXISTS idb_records (
        db_name TEXT NOT NULL,
        store_name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        key_blob BLOB NOT NULL,
        value_blob BLOB NOT NULL,
        PRIMARY KEY (db_name, store_name, key_hash)
      );
    `);
  }

  listDatabases(): DatabaseInfo[] {
    return this.db
      .prepare("SELECT name, version FROM idb_databases ORDER BY name")
      .all() as DatabaseInfo[];
  }

  listStores(dbName: string): StoreInfo[] {
    return this.db
      .prepare(`
        SELECT name, key_path_json, auto_increment, key_generator_num
        FROM idb_stores
        WHERE db_name = ?
        ORDER BY name
      `)
      .all(dbName) as StoreInfo[];
  }

  listRecords(dbName: string, storeName: string): RecordInfo[] {
    return this.db
      .prepare(`
        SELECT key_hash, key_blob, value_blob
        FROM idb_records
        WHERE db_name = ? AND store_name = ?
        ORDER BY key_hash
      `)
      .all(dbName, storeName) as RecordInfo[];
  }

  decryptRecord(
    dbName: string,
    storeName: string,
    keyHash: string,
    kind: "key" | "value",
    envelope: Uint8Array,
  ): Buffer {
    return this.cipher.decrypt(envelope, [
      "indexedDB",
      dbName,
      storeName,
      keyHash,
      kind,
    ]);
  }

  deleteDatabase(dbName: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM idb_records WHERE db_name = ?").run(dbName);
      this.db.prepare("DELETE FROM idb_stores WHERE db_name = ?").run(dbName);
      this.db.prepare("DELETE FROM idb_databases WHERE name = ?").run(dbName);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  persistDatabase(db: IDBDatabase): void {
    const rawDatabase = (db as any)._rawDatabase;
    if (!rawDatabase) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO idb_databases (name, version)
        VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET version = excluded.version
      `).run(db.name, db.version);
      this.db.prepare("DELETE FROM idb_stores WHERE db_name = ?").run(db.name);
      this.db.prepare("DELETE FROM idb_records WHERE db_name = ?").run(db.name);

      const insertStore = this.db.prepare(`
        INSERT INTO idb_stores
          (db_name, name, key_path_json, auto_increment, key_generator_num)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertRecord = this.db.prepare(`
        INSERT INTO idb_records
          (db_name, store_name, key_hash, key_blob, value_blob)
        VALUES (?, ?, ?, ?, ?)
      `);

      for (const [storeName, rawStore] of rawDatabase.rawObjectStores.entries()) {
        insertStore.run(
          db.name,
          storeName,
          JSON.stringify(rawStore.keyPath),
          rawStore.autoIncrement ? 1 : 0,
          rawStore.keyGenerator?.num ?? null,
        );
        for (const record of rawStore.records.values()) {
          const keyBlob = serialize(record.key);
          const keyHash = this.cipher.index(keyBlob);
          insertRecord.run(
            db.name,
            storeName,
            keyHash,
            this.cipher.encrypt(keyBlob, [
              "indexedDB",
              db.name,
              storeName,
              keyHash,
              "key",
            ]),
            this.cipher.encrypt(serialize(record.value), [
              "indexedDB",
              db.name,
              storeName,
              keyHash,
              "value",
            ]),
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function requestToPromise<T>(
  fn: (resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => fn(resolve, reject));
}

function transactionToPromise(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    fn(tx);
  });
}
