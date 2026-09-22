import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.RMD_STORAGE_KEY_FILE) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-test-key-"));
  const keyFile = path.join(directory, "storage.key");
  fs.writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  process.env.RMD_STORAGE_KEY_FILE = keyFile;
}
