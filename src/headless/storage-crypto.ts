import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readUserPreferences } from "../preferences.js";
import { systemKeychain } from "./system-keychain";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_MAGIC = Buffer.from("RMDENC01", "ascii");

export type StorageKeyInput = Uint8Array | Buffer;
export type StorageKeychain = {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
};

export type StorageKeyOptions = {
  explicitKey?: StorageKeyInput;
  keychain?: StorageKeychain;
  storageDbPath: string;
};

export async function resolveStorageKey(
  input: StorageKeyOptions,
): Promise<Buffer> {
  if (input.explicitKey) {
    return validateKey(Buffer.from(input.explicitKey), "explicit storage key");
  }

  const explicitKeyFile = process.env.RMD_STORAGE_KEY_FILE;
  if (explicitKeyFile) {
    return readKeyFile(explicitKeyFile);
  }

  const mode = (await readUserPreferences()).security.key_storage;
  const stateDir = path.dirname(input.storageDbPath);
  const keyFile = path.join(stateDir, "storage.key");
  const keychainFile = path.join(stateDir, "storage.keychain");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  // Serialize first use across processes so they cannot persist different keys.
  const lock = path.join(stateDir, "storage-key.lock");
  const deadline = Date.now() + 35_000;
  while (true) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Storage key is locked at ${lock}. If no Relay command is running, remove this stale lock directory and retry.`);
      await sleep(50);
    }
  }
  try {
    if (mode === "file") {
      if (await fileExists(keychainFile)) {
        throw new Error('This state directory uses keychain storage. Set security.key_storage = "keychain" in config.toml, or use a new --state-dir for file storage.');
      }
      return await createFileKey(input.storageDbPath, keyFile);
    }
    if (await fileExists(keyFile)) {
      throw new Error('This state directory already has a storage.key file. To use keychain storage, stop Relay and select a new --state-dir, then log in and reconnect your folders. Keep the original state and key together until no longer needed.');
    }
    let account: string;
    try {
      account = (await fs.readFile(keychainFile, "utf8")).trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(account)) {
        throw new Error(`Invalid keychain entry identifier at ${keychainFile}.`);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      if (await databaseExists(input.storageDbPath)) throw missingExistingDatabaseKey(input.storageDbPath);
      account = randomUUID();
      await writeDurableFile(keychainFile, `${account}\n`);
    }
    let entry: StorageKeychain;
    let stored: string | undefined;
    try {
      entry = input.keychain ?? await systemKeychain(`browser-storage-${account}`);
      stored = await entry.getPassword();
    } catch (error) {
      throw keychainUnavailable(error);
    }
    if (stored !== undefined) return decodeKey(stored, "system keychain storage key");
    if (await databaseExists(input.storageDbPath)) throw missingExistingDatabaseKey(input.storageDbPath);
    const generated = randomBytes(KEY_BYTES);
    try {
      await entry.setPassword(generated.toString("hex"));
      if (await entry.getPassword() !== generated.toString("hex")) throw new Error("Keychain did not retain the storage key.");
    } catch (error) {
      throw keychainUnavailable(error);
    }
    return generated;
  } finally {
    await fs.rmdir(lock);
  }
}

function keychainUnavailable(cause: unknown): Error {
  return new Error(
    "Cannot access the selected system keychain. Unlock or restore keychain access and retry. " +
    "Relay will not fall back to a key file. On Linux/WSL, install secret-tool and run a persistent Secret Service keyring.",
    { cause },
  );
}

async function createFileKey(storageDbPath: string, keyFile: string): Promise<Buffer> {
  if (await fileExists(keyFile)) return readKeyFile(keyFile);
  if (await databaseExists(storageDbPath)) throw missingExistingDatabaseKey(storageDbPath);
  const generated = randomBytes(KEY_BYTES);
  await writeDurableFile(keyFile, `${generated.toString("hex")}\n`);
  return generated;
}

async function writeDurableFile(file: string, value: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, file);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); }
      finally { await directory.close(); }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readKeyFile(keyFile: string): Promise<Buffer> {
  const stat = await fs.stat(keyFile);
  if (!stat.isFile()) throw new Error(`Storage key path is not a file: ${keyFile}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error(
      `Storage key file must be readable only by its owner (chmod 600): ${keyFile}`,
    );
  }
  const encoded = (await fs.readFile(keyFile, "utf8")).trim();
  return decodeKey(encoded, `storage key file ${keyFile}`);
}

async function databaseExists(dbPath: string): Promise<boolean> {
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if ((await fs.stat(candidate)).size > 0) return true;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function missingExistingDatabaseKey(dbPath: string): Error {
  return new Error(
    `The selected storage backend has no Relay storage key, but Relay storage already exists at ${dbPath}. ` +
    "Refusing to replace the missing key. Restore the original storage.key or keychain entry and storage.keychain identifier, " +
    "select the original backend in config.toml, or set RMD_STORAGE_KEY_FILE to the original storage key.",
  );
}

function decodeKey(encoded: string, source: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(encoded)) {
    throw new Error(`${source} must contain exactly 64 hexadecimal characters.`);
  }
  return validateKey(Buffer.from(encoded, "hex"), source);
}

function validateKey(key: Buffer, source: string): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`${source} must be exactly ${KEY_BYTES} bytes.`);
  }
  return key;
}

export class StorageCipher {
  readonly keyId: string;
  private readonly encryptionKey: Buffer;
  private readonly indexKey: Buffer;

  constructor(masterKey: StorageKeyInput) {
    const key = validateKey(Buffer.from(masterKey), "storage key");
    this.encryptionKey = deriveKey(key, "relay-cli/storage-encryption/v1");
    this.indexKey = deriveKey(key, "relay-cli/storage-index/v1");
    this.keyId = createHmac("sha256", key)
      .update("relay-cli/storage-key-id/v1")
      .digest("hex")
      .slice(0, 24);
  }

  encrypt(plaintext: Uint8Array, context: readonly string[]): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(contextBuffer(context));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext)),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([ENVELOPE_MAGIC, nonce, tag, ciphertext]);
  }

  decrypt(envelope: Uint8Array, context: readonly string[]): Buffer {
    const bytes = Buffer.from(envelope);
    const headerBytes = ENVELOPE_MAGIC.length + NONCE_BYTES + TAG_BYTES;
    if (
      bytes.length < headerBytes ||
      !bytes.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)
    ) {
      throw new Error("Relay storage contains an unencrypted or unsupported record.");
    }
    const nonceStart = ENVELOPE_MAGIC.length;
    const tagStart = nonceStart + NONCE_BYTES;
    const ciphertextStart = tagStart + TAG_BYTES;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      bytes.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(contextBuffer(context));
    decipher.setAuthTag(bytes.subarray(tagStart, ciphertextStart));
    try {
      return Buffer.concat([
        decipher.update(bytes.subarray(ciphertextStart)),
        decipher.final(),
      ]);
    } catch (error) {
      throw new Error("Relay storage authentication failed; the key is wrong or the record was modified.", {
        cause: error,
      });
    }
  }

  index(plaintext: Uint8Array): string {
    return createHmac("sha256", this.indexKey)
      .update(Buffer.from(plaintext))
      .digest("hex");
  }
}

function deriveKey(masterKey: Buffer, label: string): Buffer {
  return createHmac("sha256", masterKey).update(label).digest();
}

function contextBuffer(parts: readonly string[]): Buffer {
  return Buffer.from(parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join("|"), "utf8");
}
