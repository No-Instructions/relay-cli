import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StorageCipher } from "./storage-crypto";

const CRYPTO_VERSION = "1";
const DATA_TABLES = [
  "local_storage",
  "idb_databases",
  "idb_stores",
  "idb_records",
];

export function openEncryptedDatabase(
  dbPath: string,
  cipher: StorageCipher,
): DatabaseSync {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const fd = openSync(dbPath, "a", 0o600);
  closeSync(fd);
  if (process.platform !== "win32") chmodSync(dbPath, 0o600);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const version = metaValue(db, "crypto_version");
    const keyId = metaValue(db, "key_id");
    if (version === null) {
      if (hasLegacyData(db)) {
        throw new Error(
          `Relay storage at ${dbPath} predates record encryption. ` +
          "Migration is disabled; remove browser.db, browser.db-wal, and browser.db-shm, then log in again.",
        );
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare("INSERT INTO storage_meta (key, value) VALUES (?, ?)");
        insert.run("crypto_version", CRYPTO_VERSION);
        insert.run("key_id", cipher.keyId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (version !== CRYPTO_VERSION) {
      throw new Error(`Unsupported Relay storage encryption version: ${version}`);
    } else if (keyId !== cipher.keyId) {
      throw new Error("Relay storage key does not match this database.");
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function metaValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM storage_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function hasLegacyData(db: DatabaseSync): boolean {
  const tableExists = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const table of DATA_TABLES) {
    if (!tableExists.get(table)) continue;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    if (row.count > 0) return true;
  }
  return false;
}
