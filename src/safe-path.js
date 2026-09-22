import { constants, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// Remote paths must stay in the selected logical namespace. Locally configured
// symlinks may intentionally include targets outside that directory.
export function resolveSafePath(root, relative = "") {
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  const within = path.relative(base, target);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw unsafePath(relative);
  }
  return target;
}

// Index each logical alias, but stop a branch if a directory resolves to one of
// its own ancestors. Checking the entire branch also handles direct watcher
// observations below a cycle, without depending on traversal order or a cache.
export function statSyncEntry(root, relative = "") {
  const target = resolveSafePath(root, relative);
  let current = path.resolve(root);
  const ancestors = new Set();
  let stat;
  for (const segment of ["", ...path.relative(current, target).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    stat = statSync(current);
    if (!stat.isDirectory()) continue;
    const physical = realpathSync(current);
    if (ancestors.has(physical)) {
      const error = new Error(`Directory cycle in sync path: ${current}`);
      error.code = "ELOOP";
      throw error;
    }
    ancestors.add(physical);
  }
  return stat;
}

function unsafePath(candidate) {
  const error = new Error(`Unsafe sync path (outside root or not a regular file): ${candidate}`);
  error.code = "EUNSAFEPATH";
  return error;
}

export function isUnavailablePathError(error) {
  return ["ENOENT", "ENOTDIR", "ELOOP", "EUNSAFEPATH"].includes(error.code);
}

// O_NONBLOCK lets us reject FIFOs without waiting for another process to open one.
export async function openSafeFile(root, relative, flags) {
  const file = await fs.open(resolveSafePath(root, relative), flags | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw unsafePath(relative);
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
