import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_MAGIC = Buffer.from("RMDENC01", "ascii");
const KEYRING_SERVICE = "dev.system3.relay-cli";
const KEYRING_ACCOUNT = "browser-storage-v1";

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

  const keyFile = process.env.RMD_STORAGE_KEY_FILE;
  if (keyFile) {
    return readKeyFile(keyFile);
  }

  const automaticKeyFile = path.join(path.dirname(input.storageDbPath), "storage.key");
  if (await fileExists(automaticKeyFile)) return readKeyFile(automaticKeyFile);

  let entry: StorageKeychain;
  try {
    entry = input.keychain ?? await systemKeychain();
  } catch (error) {
    return createFallbackKey(input.storageDbPath, automaticKeyFile, error);
  }

  let stored: string | undefined;
  try {
    stored = await entry.getPassword();
  } catch (error) {
    return createFallbackKey(input.storageDbPath, automaticKeyFile, error);
  }
  if (stored) return decodeKey(stored, "system keychain storage key");

  const racedFallback = await readKeyFileIfExists(automaticKeyFile);
  if (racedFallback) return racedFallback;
  if (await databaseExists(input.storageDbPath)) {
    const fallbackAfterDatabase = await readKeyFileIfExists(automaticKeyFile);
    if (fallbackAfterDatabase) return fallbackAfterDatabase;
    throw missingExistingDatabaseKey(input.storageDbPath);
  }

  const generated = randomBytes(KEY_BYTES);
  try {
    await entry.setPassword(generated.toString("hex"));
    return generated;
  } catch (error) {
    return createFallbackKey(input.storageDbPath, automaticKeyFile, error);
  }
}

async function systemKeychain(): Promise<StorageKeychain> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(KEYRING_SERVICE, KEYRING_ACCOUNT);
}

async function createFallbackKey(
  storageDbPath: string,
  keyFile: string,
  cause: unknown,
): Promise<Buffer> {
  const existingFallback = await readKeyFileIfExists(keyFile);
  if (existingFallback) return existingFallback;
  if (await databaseExists(storageDbPath)) {
    const fallbackAfterDatabase = await readKeyFileIfExists(keyFile);
    if (fallbackAfterDatabase) return fallbackAfterDatabase;
    throw new Error(
      `Unable to access the system keychain, and Relay storage already exists at ${storageDbPath}. ` +
      "Refusing to create a different key because that could make existing data inaccessible. " +
      "Restore keychain access or set RMD_STORAGE_KEY_FILE to the original storage key.",
      { cause },
    );
  }

  const generated = randomBytes(KEY_BYTES);
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const temporary = `${keyFile}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${generated.toString("hex")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    try {
      await fs.link(temporary, keyFile);
      console.warn(
        `System keychain unavailable; created an owner-only Relay storage key at ${keyFile}. ` +
        "Back up this file with the state directory.",
      );
      return generated;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      return readKeyFile(keyFile);
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

async function readKeyFileIfExists(keyFile: string): Promise<Buffer | null> {
  if (!await fileExists(keyFile)) return null;
  return readKeyFile(keyFile);
}

function missingExistingDatabaseKey(dbPath: string): Error {
  return new Error(
    `The system keychain has no Relay storage key, but Relay storage already exists at ${dbPath}. ` +
    "Refusing to replace the missing key. Restore the keychain entry or set " +
    "RMD_STORAGE_KEY_FILE to the original storage key.",
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
