import { execFile } from "node:child_process";
import type { StorageKeychain } from "./storage-crypto";

const SERVICE = "dev.system3.relay-cli";

export async function systemKeychain(account: string): Promise<StorageKeychain> {
  if (process.platform === "linux") {
    // The native addon falls back to an in-memory kernel keyring on Linux.
    // Use Secret Service's default collection explicitly instead.
    const attributes = ["service", SERVICE, "account", account];
    return {
      getPassword: () => secretTool(["lookup", ...attributes]),
      async setPassword(password) {
        await secretTool(["store", "--label=Relay CLI storage", "--collection=default", ...attributes], password);
      },
    };
  }
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("Keychain storage is unsupported on this platform.");
  }
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(SERVICE, account);
}

function secretTool(args: string[], password?: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = execFile("secret-tool", args, {
      encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(password === undefined ? stdout : undefined);
      // libsecret returns 1 with no output when no matching item exists.
      if (password === undefined && error.code === 1 && !stdout && !stderr && !error.killed) return resolve(undefined);
      // Never include subprocess output: it can contain the storage key.
      reject(new Error("Cannot access persistent Secret Service storage. Install secret-tool (libsecret-tools on Debian/Ubuntu) and unlock your desktop keyring; headless Linux/WSL needs a running Secret Service session."));
    });
    child.stdin!.on("error", () => { /* The execFile callback reports a failed child. */ });
    // Keep the secret out of process arguments and the environment.
    child.stdin!.end(password ?? "");
  });
}
