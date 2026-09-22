import { assertAuthServerMatches } from "../auth-server.js";
import type { EndpointManager } from "../../vendor/relay/src/EndpointManager";
import { LoginManager, type LoginSettings } from "../../vendor/relay/src/LoginManager";
import type { NamespacedSettings } from "../../vendor/relay/src/SettingsStorage";
import type { TimeProvider } from "../../vendor/relay/src/TimeProvider";
import { readStoredLogin } from "./auth-storage";
import { buildConfig } from "./build-config";

export async function createHeadlessLoginManager(
  vaultName: string,
  server: string | undefined,
  endpointManager: EndpointManager,
  timeProvider: TimeProvider,
  loginSettings: NamespacedSettings<LoginSettings>,
): Promise<LoginManager> {
  const authKey = `pocketbase_auth_${vaultName}`;
  // Cached PocketBase records do not carry an origin. Recreate only from the
  // origin-bound login after build validation, before the constructor refreshes.
  localStorage.removeItem(authKey);
  const authUrl = endpointManager.getAuthUrl();
  assertAuthServerMatches(authUrl, buildConfig.authUrl);
  if (endpointManager.getApiUrl() !== buildConfig.apiUrl) {
    throw new Error("Relay API endpoint does not match this build.");
  }
  assertAuthServerMatches(server ?? authUrl, authUrl);
  const stored = readStoredLogin();
  if (stored?.token) {
    assertAuthServerMatches(stored.server, authUrl);
    let payload: Record<string, any> = {};
    try {
      payload = JSON.parse(Buffer.from(stored.token.split(".")[1], "base64url").toString("utf8"));
    } catch { /* An invalid token is handled by PocketBase's auth store. */ }
    const model = {
      ...payload,
      id: payload.id ?? payload.sub ?? payload.userId ?? payload.user_id ?? "",
      email: payload.email ?? "",
      name: payload.name ?? payload.username ?? "",
    };
    localStorage.setItem(authKey, JSON.stringify({ token: stored.token, model }));
  }
  return new LoginManager(vaultName, async () => {}, timeProvider, () => {}, loginSettings, endpointManager);
}
