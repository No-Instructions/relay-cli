import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const RELEASE_URL = "https://github.com/No-Instructions/relay-cli/releases";
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION.test(value)) throw new Error("Expected a release version such as 1.2.3.");
  return value;
}

export function compareVersions(a, b) {
  const left = validateVersion(a).split(".").map(BigInt);
  const right = validateVersion(b).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function assetName(platform = process.platform, arch = process.arch) {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error("Managed installations support Linux and macOS on x86-64 and ARM64.");
  }
  return `relay-cli-${platform}-${arch}.tar.gz`;
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readRelease(directory) {
  const release = await readJson(path.join(directory, "release.json"));
  if (!release) return null;
  validateVersion(release.version);
  if (release.format !== 1 || release.runtime !== "bun" || release.target !== "production" || !/^[a-f0-9]{40}$/.test(release.revision)) {
    throw new Error("Unsupported release metadata.");
  }
  assetName(release.platform, release.arch);
  return release;
}

export async function findInstallation(executable = process.execPath) {
  const binary = await fs.realpath(executable);
  const versionDir = path.dirname(binary);
  if (path.basename(binary) !== "relay" || path.basename(path.dirname(versionDir)) !== "versions") return null;
  const root = path.resolve(versionDir, "../..");
  const release = await readRelease(versionDir);
  if (!release) return null;
  const current = await fs.realpath(path.join(root, "current"));
  if (path.dirname(current) !== path.join(root, "versions")) throw new Error("Invalid managed installation link.");
  return { root, versionDir, release };
}

export async function withInstallLock(root, action) {
  const lock = path.join(root, ".install-lock");
  try { await fs.mkdir(lock); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another install or update is running. If it was interrupted, remove ${lock} and retry.`);
    throw error;
  }
  try { return await action(); }
  finally { await fs.rmdir(lock); }
}

export async function readUpdateSettings(root) {
  return { automatic: false, pinnedVersion: null, lastAttempt: 0, ...await readJson(path.join(root, "updates.json"), {}) };
}

export async function configureUpdates(installation, changes) {
  return withInstallLock(installation.root, async () => {
    const settings = { ...await readUpdateSettings(installation.root), ...changes };
    await writeJson(path.join(installation.root, "updates.json"), settings);
    return settings;
  });
}

export function automaticUpdateDue(settings, now = Date.now()) {
  return settings.automatic === true && !settings.pinnedVersion && now - settings.lastAttempt >= UPDATE_INTERVAL;
}

async function responseFor(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Release download failed (HTTP ${response.status}). Check your connection and whether a release has been published.`);
  return response;
}

async function download(url, file, fetchImpl) {
  const response = await responseFor(url, fetchImpl);
  const handle = await fs.open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 512 * 1024 * 1024) throw new Error("Release archive exceeds 512 MiB.");
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

async function textAt(url, fetchImpl) {
  const response = await responseFor(url, fetchImpl);
  let result = "";
  for await (const chunk of response.body) {
    result += Buffer.from(chunk).toString("utf8");
    if (result.length > 16_384) throw new Error("Release metadata is too large.");
  }
  return result.trim();
}

export async function selectInstallation(root, target) {
  const temporary = path.join(root, `.current-${randomUUID()}`);
  try {
    await fs.symlink(target, temporary);
    await fs.rename(temporary, path.join(root, "current"));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function prepareRelease(root, version, fetchImpl) {
  const stage = await fs.mkdtemp(path.join(root, ".update-"));
  try {
    const name = assetName();
    const base = `${RELEASE_URL}/download/v${version}`;
    const checksum = await textAt(`${base}/${name}.sha256`, fetchImpl);
    const expected = checksum.split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid release checksum.");
    const archive = path.join(stage, "release.tar.gz");
    const actual = await download(`${base}/${name}`, archive, fetchImpl);
    if (actual !== expected) throw new Error("Release checksum mismatch; the installed version is unchanged.");
    const unpacked = path.join(stage, "unpacked");
    await fs.mkdir(unpacked);
    await exec("tar", ["-xzf", archive, "-C", unpacked], { timeout: 120_000 });
    const metadata = await readRelease(unpacked);
    if (!metadata || metadata.version !== version || metadata.platform !== process.platform || metadata.arch !== process.arch) {
      throw new Error("Release metadata does not match the requested version or platform.");
    }
    const { stdout } = await exec(path.join(unpacked, "relay"), ["version", "--verify", "--json"], { timeout: 30_000 });
    const embedded = JSON.parse(stdout);
    if (embedded.version !== version || embedded.revision !== metadata.revision || embedded.target !== metadata.target) {
      throw new Error("The downloaded CLI failed its version check.");
    }
    const candidate = path.join(root, "versions", `${version}-${randomUUID()}`);
    await fs.rename(unpacked, candidate);
    return candidate;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

/** Downloads and verifies first; lifecycle adapters use the authenticated daemon protocol. */
export async function updateInstallation(installation, {
  version, check = false, scheduled = false, fetchImpl = globalThis.fetch,
  daemons = { list: async () => [], stop: async () => {}, start: async () => {} },
  log = console.log,
} = {}) {
  return withInstallLock(installation.root, async () => {
    const root = installation.root;
    const previous = await fs.realpath(path.join(root, "current"));
    const installed = await readRelease(previous);
    if (!installed) throw new Error("This installation has no release metadata.");
    const settings = await readUpdateSettings(root);
    if (scheduled && !automaticUpdateDue(settings)) return { skipped: true };
    if (scheduled) await writeJson(path.join(root, "updates.json"), { ...settings, lastAttempt: Date.now() });
    const requested = version ?? settings.pinnedVersion ?? await textAt(`${RELEASE_URL}/latest/download/version.txt`, fetchImpl);
    validateVersion(requested);
    if (settings.pinnedVersion && requested !== settings.pinnedVersion) throw new Error("This installation is pinned. Run relay update --unpin first.");
    const available = version ? requested !== installed.version : compareVersions(requested, installed.version) > 0;
    if (check || !available) {
      log(available ? `Update available: ${installed.version} → ${requested}. Run relay update.` : `Relay CLI ${installed.version} is current${settings.pinnedVersion ? " (pinned)" : ""}.`);
      return { installed: installed.version, latest: requested, available };
    }
    log(`Downloading Relay CLI ${requested}…`);
    const candidate = await prepareRelease(root, requested, fetchImpl);
    const stopped = [];
    const started = [];
    let switched = false;
    try {
      // Discover every live state directory sharing this installation, including
      // daemons started after the download began.
      const running = await daemons.list();
      for (const daemon of running) {
        await daemons.stop(daemon);
        stopped.push(daemon);
      }
      await selectInstallation(root, candidate);
      switched = true;
      for (const daemon of stopped) started.push(await daemons.start(daemon, candidate));
      log(`Updated Relay CLI ${installed.version} → ${requested}${stopped.length ? `; restarted ${stopped.length} daemon(s)` : ""}.`);
      return { installed: requested, previous: installed.version, updated: true };
    } catch (error) {
      // Do not launch the old runtime while a replacement is still writing to
      // its state. If shutdown itself fails, retain both versions for recovery.
      const blocked = error.recoveryBlocked ? [error.message] : [];
      for (const daemon of started) {
        try { await daemons.stop(daemon); }
        catch (stopError) { blocked.push(stopError.message); }
      }
      if (blocked.length) {
        throw new Error(`Update failed; recovery needs attention. A replacement may still be running, so the current version was retained. Stop the affected daemons before retrying. ${blocked.join("; ")}`, { cause: error });
      }
      if (switched) await selectInstallation(root, previous);
      const failures = [];
      for (const daemon of stopped) {
        try { await daemons.start(daemon, previous); }
        catch (restartError) { failures.push(restartError.message); }
      }
      throw new Error(`Update failed; restored Relay CLI ${installed.version}. ${error.message}${failures.length ? ` Recovery needs attention: ${failures.join("; ")}` : ""}`, { cause: error });
    }
  });
}

function registrationPath(root, stateDir) {
  return path.join(root, "daemons", `${createHash("sha256").update(stateDir).digest("hex")}.json`);
}

export async function registerDaemon(installation, registration) {
  await writeJson(registrationPath(installation.root, registration.stateDir), registration);
  return async () => {
    const file = registrationPath(installation.root, registration.stateDir);
    if ((await readJson(file))?.pid === registration.pid) await fs.rm(file, { force: true });
  };
}

export async function registeredDaemons(root) {
  const directory = path.join(root, "daemons");
  let files;
  try { files = await fs.readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return (await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson(path.join(directory, file))))).filter(Boolean);
}

/** The updater runs outside the daemon so it can wait for that daemon to exit. */
export function scheduleAutomaticUpdates(installation, { spawnWorker, onError = console.error, interval = 60_000 } = {}) {
  let worker = null;
  let checking = false;
  const tick = async () => {
    if (checking || worker) return;
    checking = true;
    try {
      if (!automaticUpdateDue(await readUpdateSettings(installation.root))) return;
      const run = spawnWorker ?? (() => spawn(path.join(installation.versionDir, "relay"), [
        "update", "--scheduled",
      ], { detached: true, stdio: "ignore" }));
      worker = run();
      worker.once("error", (error) => { worker = null; onError(error); });
      worker.once("exit", () => { worker = null; });
      worker.unref();
    } catch (error) { onError(error); }
    finally { checking = false; }
  };
  const timer = setInterval(() => { void tick(); }, interval);
  timer.unref();
  return () => clearInterval(timer);
}
