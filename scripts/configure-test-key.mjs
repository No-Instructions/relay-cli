import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests and their child processes must never read or change real preferences
// or register mock folders in the user's daemon state.
process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-test-config-"));
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-test-state-"));

if (!process.env.RMD_STORAGE_KEY_FILE) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-test-key-"));
  const keyFile = path.join(directory, "storage.key");
  fs.writeFileSync(keyFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  process.env.RMD_STORAGE_KEY_FILE = keyFile;
}
