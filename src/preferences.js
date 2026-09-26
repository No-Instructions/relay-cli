import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse, stringify } from "smol-toml";
import { userConfigPath } from "./user-paths.js";
export { userConfigPath } from "./user-paths.js";

function validate(config, file) {
  for (const [section, keys] of Object.entries({ updates: ["automatic", "notify"], logging: ["debug", "network"], security: [] })) {
    const values = config[section];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`${file}: [${section}] must be a table.`);
    for (const key of keys) {
      if (values[key] !== undefined && typeof values[key] !== "boolean") throw new Error(`${file}: ${section}.${key} must be true or false.`);
    }
  }
  const keyStorage = config.security?.key_storage;
  if (keyStorage !== undefined && !["file", "keychain"].includes(keyStorage)) {
    throw new Error(`${file}: security.key_storage must be "file" or "keychain".`);
  }
  const pin = config.updates?.pinned_version;
  if (pin !== undefined && (typeof pin !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pin))) {
    throw new Error(`${file}: updates.pinned_version must be a stable version such as "1.2.3".`);
  }
}

async function readDocument(file) {
  let config;
  try { config = parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read preferences at ${file}: ${error.message}`, { cause: error });
  }
  validate(config, file);
  return config;
}

function withDefaults(config) {
  const logging = { debug: false, network: false, ...config.logging };
  if (logging.network) logging.debug = true;
  return { ...config, updates: { automatic: false, notify: true, ...config.updates }, logging, security: { key_storage: "file", ...config.security } };
}

export async function readUserPreferences(file = userConfigPath()) {
  return withDefaults(await readDocument(file));
}

export async function updateUserPreferences(patch, file = userConfigPath()) {
  // Follow a linked config file and replace its target atomically.
  try { file = await fs.realpath(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Preferences are locked at ${lock}. Retry after the other Relay command finishes.`);
      await sleep(25);
    }
  }
  const temporary = `${file}.${randomUUID()}`;
  try {
    const document = await readDocument(file);
    for (const [section, changes] of Object.entries(patch)) {
      const values = { ...document[section], ...changes };
      for (const key of Object.keys(values)) if (values[key] === null) delete values[key];
      document[section] = values;
    }
    validate(document, file);
    await fs.writeFile(temporary, stringify(document), { mode: 0o600 });
    await fs.rename(temporary, file);
    return withDefaults(document);
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rmdir(lock);
  }
}

export async function updateLoggingPreferences(logging) {
  const changes = {};
  if (typeof logging.debugging === "boolean") changes.debug = logging.debugging;
  if (typeof logging.network === "boolean") {
    changes.network = logging.network;
    if (logging.network) changes.debug = true;
  }
  return updateUserPreferences({ logging: changes });
}
