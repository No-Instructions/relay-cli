import { normalizeAuthServer } from "../auth-server.js";

export type StoredLogin = {
  server: string;
  token: string;
  updatedAt: string;
};

const LOGIN_STORAGE_KEY = "relay-cli/auth/v1";
const POCKETBASE_AUTH_PREFIX = "pocketbase_auth_";

export function readStoredLogin(): StoredLogin | null {
  const serialized = localStorage.getItem(LOGIN_STORAGE_KEY);
  if (!serialized) return null;
  const parsed = JSON.parse(serialized) as Partial<StoredLogin>;
  if (typeof parsed.server !== "string" || typeof parsed.token !== "string") {
    throw new Error("Encrypted Relay login record is invalid.");
  }
  return {
    server: parsed.server,
    token: parsed.token,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
  };
}

export function writeStoredLogin(login: StoredLogin): void {
  localStorage.setItem(LOGIN_STORAGE_KEY, JSON.stringify({ ...login, server: normalizeAuthServer(login.server) }));
}

export function updateStoredLoginToken(token: string, server: string): void {
  const login = readStoredLogin();
  if (!login || login.token === token || normalizeAuthServer(login.server) !== normalizeAuthServer(server)) return;
  writeStoredLogin({
    ...login,
    token,
    updatedAt: new Date().toISOString(),
  });
}

export function clearStoredLogin(): void {
  localStorage.removeItem(LOGIN_STORAGE_KEY);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(POCKETBASE_AUTH_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => localStorage.removeItem(key));
}
