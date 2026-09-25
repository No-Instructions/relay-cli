import os from "node:os";
import path from "node:path";

export function userConfigPath(env = process.env, home = os.homedir(), platform = process.platform) {
  const directory = env.XDG_CONFIG_HOME || (platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : path.join(home, ".config"));
  if (!path.isAbsolute(directory)) throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  return path.join(directory, "relay", "config.toml");
}

export function defaultStateDir(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "relay");
  return platform === "darwin"
    ? path.join(home, "Library", "Application Support", "relay", "state")
    : path.join(home, ".local", "state", "relay");
}
